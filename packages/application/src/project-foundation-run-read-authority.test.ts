import assert from "node:assert/strict";
import test from "node:test";
import { foundationToolsOwnerFixture } from "../../../apps/runtime-worker/src/plugins/project-foundation-tools-service-owner.test-support.ts";
import {
  captureProjectFoundationRunReadAuthority,
  captureProjectFoundationRunCommitTransaction,
} from "./project-foundation-run-commit-authority.ts";

// Actual original Run/Tool/sidecar writers; named installation and external policy.
// Capture alone lends no Store access and does not verify persisted lease or invoke a model.
test("independent Foundation read evidence pins actual operation, source and sidecar without becoming a proposal write grant", async (t) => {
  const f = await foundationToolsOwnerFixture(t, "novel");
  assert.ok(f.admission.source);
  const request = {
    projectId: f.admission.projectId,
    sourceRevision: f.admission.source.revision,
    sourceDigest: f.admission.source.digest,
    startOffset: 0,
    limit: 5,
  };
  const op = await f.prepare("readSourcePage", request);
  let live = true;
  const input = {
    version: "crewon.project-foundation-run-read.v1",
    actor: f.actor,
    run: op.run,
    receipt: op.receipt,
    claim: op.claim,
    commandInput: op.command.input,
    operationId: "foundation_source_page",
    installation: f.admission.installation,
    admission: f.taskAdmission,
    projectStageAdmission: f.stage,
    foundationAdmission: f.admission,
    async assertCurrent() {
      assert.ok(live, "named-read-withdrawn");
    },
  };
  // Snapshot data are the same installed facts used by the original owner.
  const installationScope = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    profileId: f.admission.installation.profileId,
  };
  const selection = await f.dependencies.installations.loadSelection({
    scope: installationScope,
    pluginId: f.admission.installation.pluginId,
  });
  const pkg = await f.dependencies.installations.loadPackage({
    scope: installationScope,
    packageDigest: f.admission.installation.packageDigest,
  });
  assert.ok(selection);
  assert.ok(pkg);
  const evidence = { ...input, selection, package: pkg };
  const q = captureProjectFoundationRunReadAuthority(evidence);
  assert.notEqual(q.run, op.run);
  assert.ok(Object.isFrozen(q));
  assert.ok(Object.isFrozen(q.foundationAdmission));
  assert.equal(q.operationId, "foundation_source_page");
  assert.equal(q.receipt.receiptId, op.receipt.receiptId);
  assert.deepEqual(q.foundationAdmission.source, f.admission.source);
  await q.assertCurrent();
  for (const changed of [
    { ...evidence, version: "crewon.project-foundation-run-commit.v1" },
    { ...evidence, operationId: "foundation_proposal_save" },
    {
      ...evidence,
      commandInput: JSON.stringify({
        ...request,
        sourceRevision: request.sourceRevision + 1,
      }),
    },
    { ...evidence, operationId: "foundation_chapters" },
    {
      ...evidence,
      receipt: { ...op.receipt, effect: "mutation", recovery: "reconcilable" },
    },
    {
      ...evidence,
      run: {
        ...op.run,
        status: "reconciling",
        reconciliationReceiptId: op.receipt.receiptId,
      },
    },
    {
      ...evidence,
      foundationAdmission: { ...f.admission, projectId: "foreign-project" },
    },
  ])
    assert.throws(
      () => captureProjectFoundationRunReadAuthority(changed),
      /project_foundation_run_read_authority_invalid/u,
    );
  assert.throws(
    () => captureProjectFoundationRunCommitTransaction(q),
    /project_foundation_run_commit_authority_invalid/u,
  );
  let getterCalls = 0;
  const accessor = { ...evidence };
  Object.defineProperty(accessor, "actor", {
    enumerable: true,
    get() {
      getterCalls++;
      return f.actor;
    },
  });
  assert.throws(() => captureProjectFoundationRunReadAuthority(accessor));
  assert.equal(getterCalls, 0);
  live = false;
  await assert.rejects(q.assertCurrent(), /named-read-withdrawn/u);
  const nonVoid = captureProjectFoundationRunReadAuthority({
    ...evidence,
    async assertCurrent() {
      return true;
    },
  });
  await assert.rejects(nonVoid.assertCurrent());
});
