import assert from "node:assert/strict";
import { test } from "node:test";
import { captureProjectFoundationRunCommitTransaction } from "@crewon/application";
import {
  validateProjectProposal,
  extensionCanonicalJson,
} from "@crewon/domain";
import {
  foundationToolFixture,
  foundationHasCause,
} from "./project-foundation-run-commit.test-support.ts";
import { foundationRunTestOptions } from "./project-foundation-run.test-support.ts";
import { creativeStoreDigester as digester } from "./creative-project-store-records.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: original unknown Tool receipt recovers with a new real queue lease and cold Worker attempt without another proposal`,
    foundationRunTestOptions(backend),
    async (t) => {
      const f = await foundationToolFixture(t, backend),
        op = await f.prepare();
      const first = await f
        .application()
        .saveProposal(f.actor, op.command, op.options);
      const unknown = await f.parent.transitionToolExecution({
        tenantId: f.actor.tenantId,
        runId: f.locator.runId,
        receiptId: op.receipt.receiptId,
        lease: f.lease,
        expectedRevision: op.receipt.revision,
        transition: {
          kind: "unknownOutcome",
          providerReceiptId: null,
          occurredAt: new Date().toISOString(),
        },
      });
      await f.parent.retryWorkItem({
        ...f.lease,
        retryAfterMs: 0,
        reasonCode: "foundation-native-owner-retired",
      });
      await f.parent.close();
      const next = (await f.open()).parent;
      const claim = await next.claimNextWorkItem({
        ownerId: "foundation-next-worker",
        leaseId: "foundation-next-lease",
        leaseDurationMs: 300000,
      });
      assert.ok(claim);
      assert.ok(claim.lease.epoch > op.transaction.claim.lease.epoch);
      const lease = {
        workItemId: claim.workItem.workItemId,
        ownerId: claim.lease.ownerId,
        leaseId: claim.lease.leaseId,
        leaseEpoch: claim.lease.epoch,
      };
      await next.beginRunAttempt({
        tenantId: f.actor.tenantId,
        runId: f.locator.runId,
        lease,
        stepId: unknown.stepId,
        attemptId: "foundation-next-attempt",
        kind: "tool",
        startedAt: new Date().toISOString(),
      });
      const run = await next.loadRun(f.locator);
      assert.ok(run);
      const service = f.application(next);
      await assert.rejects(
        service.saveProposal(f.actor, op.command, op.options),
      );
      const transaction = captureProjectFoundationRunCommitTransaction({
        ...op.transaction,
        run,
        receipt: unknown,
        claim,
      });
      const before = await f.count("project_foundation_mutation_receipts");
      const result = await service.saveProposal(f.actor, op.command, {
        authority: { ...op.options.authority!, runTransaction: transaction },
      });
      assert.equal(result.disposition, "replayed");
      assert.deepEqual({ ...result, disposition: "committed" }, first);
      assert.equal(await f.count("project_proposals"), 2);
      assert.equal(
        await f.count("project_foundation_mutation_receipts"),
        before,
      );
    },
  );
  test(
    `${backend}: actual original Tool appends a candidate only; lost ACK/cold replay returns its committed frozen fact after parameters change`,
    foundationRunTestOptions(backend),
    async (t) => {
      const f = await foundationToolFixture(t, backend),
        op = await f.prepare();
      const prior = await f.count("project_foundation_mutation_receipts");
      const result = await f
        .application()
        .saveProposal(f.actor, op.command, op.options);
      assert.equal(result.disposition, "committed");
      assert.equal(result.foundation.revision, f.admission.foundationRevision);
      assert.equal(result.proposal?.revision, 2);
      assert.equal(result.proposal?.text, op.request.text);
      assert.deepEqual(
        result.foundation.confirmedProposal,
        f.admission.confirmedProposal,
      );
      assert.equal(result.foundation.confirmedProposal?.revision, 1);
      assert.equal(await f.count("project_proposals"), 2);
      assert.equal(
        await f.count("project_foundation_mutation_receipts"),
        prior + 1,
      );
      assert.equal(await f.count("run_snapshots"), 1);
      assert.equal(await f.count("project_foundation_run_admissions"), 1);
      await f.foundation.invalidate();
      const afterChange = await f.count("project_foundation_mutation_receipts");
      const cold = await f.open();
      const replay = await f
        .application(cold.parent)
        .saveProposal(f.actor, op.command, op.options);
      assert.deepEqual({ ...replay, disposition: "committed" }, result);
      assert.equal(replay.disposition, "replayed");
      assert.equal(await f.count("project_proposals"), 2);
      assert.equal(
        await f.count("project_foundation_mutation_receipts"),
        afterChange,
      );
      assert.equal(
        (
          await cold.parent.projectFoundationStore().loadFoundation({
            owner: {
              tenantId: f.actor.tenantId,
              spaceId: f.actor.spaceId,
              principalId: f.actor.principalId,
            },
            projectId: f.admission.projectId,
          })
        )?.revision,
        f.foundation.foundation.revision,
      );
    },
  );
  test(
    `${backend}: a fresh original Tool cannot save against changed Foundation parameters`,
    foundationRunTestOptions(backend),
    async (t) => {
      const f = await foundationToolFixture(t, backend),
        op = await f.prepare();
      await f.foundation.invalidate();
      const receipts = await f.count("project_foundation_mutation_receipts");
      await assert.rejects(
        f.application().saveProposal(f.actor, op.command, op.options),
        foundationHasCause("project_foundation_run_inputs_stale"),
      );
      assert.equal(await f.count("project_proposals"), 1);
      assert.equal(
        await f.count("project_foundation_mutation_receipts"),
        receipts,
      );
    },
  );
  test(
    `${backend}: an independently valid candidate cannot replace the original Tool request`,
    foundationRunTestOptions(backend),
    async (t) => {
      const f = await foundationToolFixture(t, backend),
        op = await f.prepare();
      const original = await f
        .application()
        .saveProposal(f.actor, op.command, op.options);
      assert.ok(original.proposal);
      const { contentDigest: _digest, ...savedBody } = original.proposal;
      const body = { ...savedBody, text: "不同于原工具输入的内容" };
      const altered = validateProjectProposal({
        ...body,
        contentDigest: digester.sha256(extensionCanonicalJson(body)),
      });
      await assert.rejects(
        f.store.commitProposal(
          {
            actor: f.actor,
            receipt: {
              idempotencyKey: op.command.idempotencyKey,
              requestDigest: digester.sha256(
                extensionCanonicalJson({
                  schemaVersion: "crewon.project-foundation-command.v1",
                  actor: f.actor,
                  kind: "save-proposal",
                  command: op.command,
                }),
              ),
            },
            project: original.project,
            foundation: original.foundation,
            expectedFoundationRevision: original.foundation.revision,
            proposal: altered,
          },
          op.options,
        ),
        foundationHasCause(
          "project_foundation_run_commit_qualification_denied",
        ),
      );
      await assert.rejects(
        f
          .application()
          .saveProposal(
            f.actor,
            { ...op.command, text: altered.text },
            op.options,
          ),
        foundationHasCause("project_foundation_run_commit_authority_invalid"),
      );
      assert.equal(await f.count("project_proposals"), 2);
    },
  );
  test(
    `${backend}: revoked policy and current binding cannot use an existing receipt as a write grant`,
    foundationRunTestOptions(backend),
    async (t) => {
      const f = await foundationToolFixture(t, backend),
        op = await f.prepare();
      await f.application().saveProposal(f.actor, op.command, op.options);
      const receipts = await f.count("project_foundation_mutation_receipts");
      f.state.policy = false;
      await assert.rejects(
        f.application().saveProposal(f.actor, op.command, op.options),
        foundationHasCause("authorization_denied"),
      );
      f.state.policy = true;
      await f.parent
        .projectConversationStore()
        .commitBinding(f.mutate(f.prepared.binding, "set-state"), {
          authority: f.authority,
        });
      await assert.rejects(
        f.application().saveProposal(f.actor, op.command, op.options),
        foundationHasCause("project_foundation_run_facts_invalid"),
      );
      await f.store
        .loadMutationReceipt(
          {
            actor: f.actor,
            kind: "save-proposal",
            receipt: {
              idempotencyKey: op.command.idempotencyKey,
              requestDigest: digester.sha256(
                JSON.stringify({ wrong: "receipt" }),
              ),
            },
          },
          op.options,
        )
        .then(
          () => assert.fail("invalid receipt accepted"),
          () => undefined,
        );
      assert.equal(
        await f.count("project_foundation_mutation_receipts"),
        receipts,
      );
      assert.equal(await f.count("project_proposals"), 2);
    },
  );
}

test(
  "postgres: final external withdrawal rolls back the actual candidate and receipt on the original max-one parent pool",
  foundationRunTestOptions("postgres"),
  async (t) => {
    const f = await foundationToolFixture(t, "postgres"),
      op = await f.prepare();
    const receipts = await f.count("project_foundation_mutation_receipts");
    f.state.beforeTransaction = () => {
      if (f.state.checks === 2) f.state.live = false;
    };
    await assert.rejects(
      f.application().saveProposal(f.actor, op.command, op.options),
      foundationHasCause("foundation_native_withdrawn"),
    );
    assert.equal(f.state.checks, 2);
    assert.equal(await f.count("project_proposals"), 1);
    assert.equal(
      await f.count("project_foundation_mutation_receipts"),
      receipts,
    );
  },
);
