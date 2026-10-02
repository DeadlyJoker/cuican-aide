import assert from "node:assert/strict";
import test from "node:test";
import {
  actor,
  scope,
} from "./installed-plugin-business-execution.integration.test-support.ts";
import {
  assertKreaEvidence,
  kreaExecutionFixture,
} from "./installed-plugin-krea2.integration.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    timeout: 60_000,
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: installed SDK Krea2 package executes a paid Run through actual Worker IO and preserves the default Agent`,
    options,
    async (t) => {
      const f = await kreaExecutionFixture(t, backend);
      const request = await f.prepareTask("krea-installed");
      const accepted = await request.create();
      const replay = await request.create();
      assert.equal(replay.run.disposition, "replayed");
      assert.equal(replay.binding.runId, accepted.binding.runId);
      assert.deepEqual(replay.binding, accepted.binding);
      assert.deepEqual(replay.creditAdmission, accepted.creditAdmission);
      const admission = await f.extensions.loadPluginTaskAdmission(
        accepted.binding,
      );
      assert.ok(admission);
      assert.equal(admission.packageDigest, f.pkg.installed.packageDigest);
      assert.equal(admission.profileId, scope.profileId);
      assert.equal(admission.action, "image.generate");
      assert.equal(admission.contributionId, "studio");
      assert.equal(
        accepted.creditAdmission?.reservation.scope.principalId,
        actor.principalId,
      );
      const defaultRun = await f.defaultTask();
      const owned = await f.openWorker();
      const first = await owned.worker.wake();
      const second = await owned.worker.wake();
      assert.equal(first.kind, "completed", JSON.stringify(first));
      assert.equal(second.kind, "completed", JSON.stringify(second));
      const { events } = await assertKreaEvidence(f, accepted);
      assert.equal(
        events.filter((event) => event.type === "tool.requested").length,
        2,
      );
      const defaultMessages = await f.store.listMessages(
        { tenantId: actor.tenantId, threadId: defaultRun.threadState.threadId },
        0,
        100,
      );
      assert.match(defaultMessages.at(-1)!.content, /original-default-answer/u);
      assert.equal((await owned.worker.wake()).kind, "idle");
      assert.equal(
        f.requests.filter((request) => request.method === "GET").length,
        1,
      );
      await f.closeWorker();
    },
  );

  for (const loseAcceptance of [false, true])
    test(
      `${backend}: installed Krea2 ${loseAcceptance ? "lost provider reply" : "accepted submit"} recovers cold after disable with one POST`,
      options,
      async (t) => {
        const f = await kreaExecutionFixture(t, backend, { loseAcceptance });
        const request = await f.prepareTask(
          loseAcceptance ? "krea-lost" : "krea-cold",
        );
        const accepted = await request.create();
        const admission = await f.extensions.loadPluginTaskAdmission(
          accepted.binding,
        );
        const first = await f.openWorker({
          afterToolProviderResolved: async () => {
            throw new Error("fixture_krea_owner_loss_before_receipt_commit");
          },
        });
        assert.deepEqual(await first.worker.wake(), {
          kind: "retried",
          runId: accepted.binding.runId,
          code: "fixture_krea_owner_loss_before_receipt_commit",
        });
        const original = await f.operations.listExternalOperations({
          tenantId: actor.tenantId,
          runId: accepted.binding.runId,
          bindingDigest: accepted.binding.bindingDigest,
          limit: 16,
        });
        assert.equal(original.operations.length, 1);
        assert.equal(
          original.operations[0]!.status,
          loseAcceptance ? "submitting" : "submitted",
        );
        assert.equal(
          original.operations[0]!.providerOperationId,
          loseAcceptance ? null : f.submissions[0]!.prompt_id,
        );
        const interrupted = await f.store.loadToolExecutionReceiptByAction({
          tenantId: actor.tenantId,
          runId: accepted.binding.runId,
          actionDigest: original.operations[0]!.actionDigest,
        });
        assert.equal(interrupted?.status, "dispatched");
        const cursor = (
          await f.store.listRunEvents(accepted.binding, 0, 128)
        ).at(-1)!.sequence;
        await f.closeWorker();
        await f.select("disabled");
        const forbidden = await f.prepareTask("krea-disabled");
        await assert.rejects(forbidden.create());
        const recovered = await f.openWorker();
        assert.deepEqual(await recovered.worker.wake(), {
          kind: "completed",
          runId: accepted.binding.runId,
        });
        const { events } = await assertKreaEvidence(f, accepted);
        assert.ok(
          events
            .filter((event) => event.sequence > cursor)
            .some((event) => event.type === "model.output.delta"),
        );
        assert.deepEqual(
          await f.extensions.loadPluginTaskAdmission(accepted.binding),
          admission,
        );
        assert.equal(f.currentSelection()?.state, "disabled");
        assert.equal(
          f.requests.filter((request) => request.method === "GET").length,
          1,
        );
        assert.equal(await f.count("run_snapshots"), 1);
        assert.equal((await recovered.worker.wake()).kind, "idle");
        await f.closeWorker();
      },
    );
}
