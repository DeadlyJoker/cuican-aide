import assert from "node:assert/strict";
import test from "node:test";
import {
  markToolExecutionUnknownOutcome,
  extensionToolName,
} from "@crewon/domain";
import {
  captureProjectOutlineRunCommitTransaction,
  deriveProjectOutlineToolMutationIdempotencyKey,
  projectOutlineRunMutationCommand,
  qualifyProjectOutlineRunCommand,
} from "./project-outline-run-commit-authority.ts";
import {
  captureCreativeProjectCommitAuthority,
  assertCreativeProjectCommitActive,
  assertCreativeProjectCommitTransactionCurrent,
} from "./creative-project-commit-authority.ts";
import {
  outlineRunCommitFixture as fixture,
  outlineRunWithRequest,
} from "./project-outline-run-commit-authority.test-support.ts";
import { foundationRunSealRecord } from "./project-foundation-run-commit-authority.test-support.ts";

const invalid = /project_outline_run_commit_authority_invalid/u;
const mode = {
  allowTextUiTransaction: false,
  allowOutlineRunTransaction: true,
};

test("independent outline candidate capture freezes input and binds the original callbacks", async () => {
  const f = fixture();
  const q = captureProjectOutlineRunCommitTransaction(f.transaction);
  const captured = captureCreativeProjectCommitAuthority(
    { authority: f.authority },
    mode,
  );
  assert.equal(q.operationId, "outline_change");
  assert.equal(q.version, "crewon.project-outline-run-commit.v2");
  assert.ok(Object.isFrozen(q.receipt.call));
  assert.ok(Object.isFrozen(q.claim.lease));
  assert.ok(Object.isFrozen(q.projectStageAdmission.sources));
  const original = q.commandInput;
  f.transaction.commandInput = "replaced";
  f.transaction.assertCurrent = async () => {
    throw new Error("replacement callback");
  };
  assert.equal(q.commandInput, original);
  await q.assertCurrent();
  await assertCreativeProjectCommitTransactionCurrent(captured);
  assertCreativeProjectCommitActive(captured);
  assert.deepEqual(f.calls, { current: 0, transaction: 2, active: 1 });
});

test("legacy Run, manual UI and a copied installation pin cannot qualify outline changes", () => {
  const f = fixture();
  for (const version of [
    "crewon.creative-project-run-commit.v1",
    "crewon.project-outline-plugin-commit.v2",
    "crewon.project-outline-run-commit.v1",
  ])
    assert.throws(
      () =>
        captureProjectOutlineRunCommitTransaction({
          ...f.transaction,
          version,
        }),
      invalid,
    );
  for (const operationId of [
    "outline_save",
    "script_save",
    "foundation_proposal_save",
    "select-revision",
    "set-lock",
  ])
    assert.throws(
      () =>
        captureProjectOutlineRunCommitTransaction({
          ...f.transaction,
          operationId,
        }),
      invalid,
    );
  for (const key of [
    "run",
    "receipt",
    "claim",
    "admission",
    "projectStageAdmission",
    "assertCurrent",
  ]) {
    const input: Record<string, unknown> = { ...f.transaction };
    delete input[key];
    assert.throws(
      () => captureProjectOutlineRunCommitTransaction(input),
      invalid,
    );
  }
  assert.throws(
    () => captureCreativeProjectCommitAuthority({ authority: f.authority }),
    /creative_project_commit_authority_invalid/u,
  );
  for (const key of [
    "runTransaction",
    "outlineUiTransaction",
    "textUiTransaction",
    "planTransaction",
    "transaction",
  ])
    assert.throws(
      () =>
        captureCreativeProjectCommitAuthority(
          { authority: { ...f.authority, [key]: {} } },
          mode,
        ),
      /creative_project_commit_authority_invalid/u,
    );
});

test("exact Tool input and scoped stage prevent foreign, stale, oversized and caller-keyed commands", () => {
  const f = fixture();
  for (const patch of [
    { projectId: "foreign" },
    { expectedFoundationRevision: 0 },
    { expectedFoundationRevision: null },
    { briefRevision: 2 },
    { idempotencyKey: "caller" },
    { owner: f.actor },
    { selectedContentRevision: 1 },
    { locked: true },
    {
      change: {
        kind: "upsert",
        collection: "characters",
        items: [],
        removeIds: Array.from({ length: 11 }, (_, i) => `id-${i}`),
      },
    },
    {
      change: { kind: "overview", value: { synopsis: "a".repeat(60 * 1024) } },
    },
    { base: null },
  ])
    assert.throws(
      () =>
        captureProjectOutlineRunCommitTransaction(
          outlineRunWithRequest(f, { ...f.request, ...patch }),
        ),
      invalid,
    );
  assert.throws(
    () =>
      captureProjectOutlineRunCommitTransaction({
        ...f.transaction,
        commandInput: JSON.stringify({
          ...f.request,
          expectedArtifactRevision: 2,
        }),
      }),
    invalid,
  );
  for (const patch of [
    { runId: "foreign" },
    { threadId: "foreign" },
    { requestDigest: f.d.sha256("foreign") },
    { taskInputDigest: f.d.sha256("foreign") },
    { pluginTaskAdmissionDigest: f.d.sha256("foreign") },
    { actor: { ...f.actor, principalId: "foreign" } },
    { stage: { kind: "brief", briefRevision: 1 } as const },
  ])
    assert.throws(
      () =>
        captureProjectOutlineRunCommitTransaction({
          ...f.transaction,
          projectStageAdmission: foundationRunSealRecord(
            f.transaction.projectStageAdmission,
            patch,
          ),
        }),
      invalid,
    );
});

test("receipt, claim, running actor and current installed package must agree", () => {
  const f = fixture();
  for (const patch of [
    { actor: { ...f.actor, actorId: "foreign" } },
    { run: { ...f.transaction.run, status: "completed" } },
    { run: { ...f.transaction.run, cancelRequested: true } },
    { selection: { ...f.transaction.selection, state: "disabled" } },
    { installation: { ...f.transaction.installation, selectionRevision: 7 } },
    {
      package: {
        ...f.transaction.package,
        packageDigest: f.d.sha256("foreign"),
      },
    },
    {
      receipt: {
        ...f.transaction.receipt,
        call: {
          ...f.transaction.receipt.call,
          name: extensionToolName(
            f.transaction.installation.pluginId,
            "outline_save",
          ),
        },
      },
    },
    {
      receipt: {
        ...f.transaction.receipt,
        actionDigest: f.d.sha256("foreign"),
      },
    },
    {
      claim: {
        ...f.transaction.claim,
        workItem: { ...f.transaction.claim.workItem, runId: "foreign" },
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
        lease: { ...f.transaction.claim.lease, expiresAt: "invalid" },
      },
    },
  ])
    assert.throws(
      () =>
        captureProjectOutlineRunCommitTransaction({
          ...f.transaction,
          ...patch,
        }),
      invalid,
    );
});

test("same original receipt reconciliation preserves retry identity; new execution remains distinct", () => {
  const f = fixture();
  const q = captureProjectOutlineRunCommitTransaction(f.transaction);
  const key = deriveProjectOutlineToolMutationIdempotencyKey(q, f.d);
  assert.match(key, /^project-outline-tool:[a-f0-9]{64}$/u);
  const receipt = markToolExecutionUnknownOutcome(f.transaction.receipt, {
    observedAt: "2026-10-08T00:00:03.000Z",
    providerReceiptId: null,
  });
  const resumed = captureProjectOutlineRunCommitTransaction({
    ...f.transaction,
    receipt,
    run: {
      ...f.transaction.run,
      status: "reconciling",
      reconciliationReceiptId: receipt.receiptId,
    },
  });
  assert.equal(
    deriveProjectOutlineToolMutationIdempotencyKey(resumed, f.d),
    key,
  );
  for (const patch of [
    { receiptId: "different" },
    { executionId: "different" },
  ]) {
    const next = captureProjectOutlineRunCommitTransaction({
      ...f.transaction,
      receipt: { ...f.transaction.receipt, ...patch },
    });
    assert.notEqual(
      deriveProjectOutlineToolMutationIdempotencyKey(next, f.d),
      key,
    );
  }
  assert.throws(
    () =>
      captureProjectOutlineRunCommitTransaction({
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

test("qualified Run may append its exact candidate but never adopt, lock or substitute another command", () => {
  const f = fixture();
  const q = captureProjectOutlineRunCommitTransaction(f.transaction);
  const command = projectOutlineRunMutationCommand(q, f.d);
  assert.doesNotThrow(() =>
    qualifyProjectOutlineRunCommand(
      f.authority,
      f.actor,
      "save-outline",
      command,
      f.d,
    ),
  );
  assert.throws(
    () =>
      qualifyProjectOutlineRunCommand(
        f.authority,
        f.actor,
        "select-revision",
        command,
        f.d,
      ),
    invalid,
  );
  assert.throws(
    () =>
      qualifyProjectOutlineRunCommand(
        f.authority,
        { ...f.actor, principalId: "foreign" },
        "save-outline",
        command,
        f.d,
      ),
    invalid,
  );
  for (const patch of [
    { expectedArtifactRevision: 2 },
    { idempotencyKey: "caller" },
    { base: { contentRevision: 2, contentDigest: f.d.sha256("different") } },
  ])
    assert.throws(
      () =>
        qualifyProjectOutlineRunCommand(
          f.authority,
          f.actor,
          "save-outline",
          { ...command, ...patch },
          f.d,
        ),
      invalid,
    );
});

test("accessors and hooks are rejected without execution; current check cannot return a replacement grant", async () => {
  const f = fixture();
  let calls = 0;
  for (const key of Object.keys(f.transaction)) {
    const value = Object.defineProperty({ ...f.transaction }, key, {
      enumerable: true,
      get() {
        calls++;
        return null;
      },
    });
    assert.throws(
      () => captureProjectOutlineRunCommitTransaction(value),
      invalid,
    );
  }
  assert.throws(
    () =>
      captureProjectOutlineRunCommitTransaction({
        ...f.transaction,
        claim: {
          ...f.transaction.claim,
          toJSON() {
            calls++;
            return {};
          },
        },
      }),
    invalid,
  );
  assert.equal(calls, 0);
  const nonVoid = captureProjectOutlineRunCommitTransaction({
    ...f.transaction,
    assertCurrent: async () => false,
  });
  await assert.rejects(nonVoid.assertCurrent(), invalid);
  const withdrawn = captureProjectOutlineRunCommitTransaction({
    ...f.transaction,
    assertCurrent: async () => {
      throw new Error("permission withdrawn");
    },
  });
  await assert.rejects(withdrawn.assertCurrent(), /permission withdrawn/u);
});
