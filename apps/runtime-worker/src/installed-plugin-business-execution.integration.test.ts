import assert from "node:assert/strict";
import test from "node:test";
import { createInstalledPluginAgentVersionRuntimeFactory } from "./plugins/installed-plugin-agent-runtime-factory.ts";
import { installedPluginRunMaterialization } from "./plugins/installed-plugin-run-runtime.ts";
import {
  businessExecutionFixture,
  actor,
  scope,
} from "./installed-plugin-business-execution.integration.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    timeout: 60_000,
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: real installed business materialization executes through the owned standalone Worker and paid admission`,
    options,
    async (t) => {
      const f = await businessExecutionFixture(t, backend);
      const request = await f.prepareTask("original");
      const accepted = await request.create();
      const replay = await request.create();
      assert.deepEqual(
        {
          ...replay,
          run: { ...replay.run, disposition: "committed" },
          turn: { ...replay.turn, disposition: "committed" },
        },
        accepted,
      );
      assert.equal(replay.run.disposition, "replayed");
      assert.equal(replay.turn.disposition, "replayed");
      assert.equal(f.controls.quotes, 1);
      assert.equal(await f.count("run_snapshots"), 1);
      assert.equal(await f.count("plugin_credit_reservations"), 1);
      assert.equal(await f.count("plugin_task_admissions"), 1);
      const admission = await f.extensions.loadPluginTaskAdmission(
        accepted.binding,
      );
      assert.ok(admission);
      assert.equal(admission.profileId, scope.profileId);
      assert.equal(
        admission.packageDigest,
        f.entry.registration.identity.packageDigest,
      );
      assert.ok(accepted.creditAdmission);
      assert.equal(
        accepted.creditAdmission.reservation.scope.principalId,
        actor.principalId,
      );
      const baseline = await f.defaultTask();
      const worker = await f.openWorker();
      const first = await worker.worker.wake();
      assert.equal(
        first.kind,
        "completed",
        JSON.stringify({ first, models: f.controls.models }),
      );
      const second = await worker.worker.wake();
      assert.equal(
        second.kind,
        "completed",
        JSON.stringify({ second, models: f.controls.models }),
      );
      assert.equal(f.controls.executes.length, 1);
      assert.equal(f.controls.factories.length, 1);
      assert.deepEqual(f.controls.executes, ["1.0.0"]);
      assert.equal(f.controls.outcomes.size, 1);
      assert.equal((await worker.worker.wake()).kind, "idle");
      const completedReplay = await request.create();
      assert.deepEqual(
        {
          ...completedReplay,
          run: { ...completedReplay.run, disposition: "committed" },
          turn: { ...completedReplay.turn, disposition: "committed" },
        },
        accepted,
      );
      assert.equal(f.controls.quotes, 1);
      assert.equal(await f.count("run_snapshots"), 2);
      assert.equal(await f.count("plugin_credit_reservations"), 1);
      assert.deepEqual(
        await f.extensions.loadPluginTaskAdmission(accepted.binding),
        admission,
      );
      const messages = await f.store.listMessages(accepted.binding, 0, 100);
      assert.match(
        JSON.stringify(messages.at(-1)?.content),
        /answer:professional:1\.0\.0:Fixture company/,
      );
      const defaultMessages = await f.store.listMessages(
        { tenantId: actor.tenantId, threadId: baseline.threadState.threadId },
        0,
        100,
      );
      assert.match(
        JSON.stringify(defaultMessages.at(-1)?.content),
        /original-default-answer/,
      );
      const active = await f.store.loadActiveAgentVersionRelease({
        tenantId: actor.tenantId,
      });
      assert.equal(
        active?.bundle.defaultAgentVersionId,
        f.entry.base.version.agentVersionId,
      );
      const account = await f.credits.getAccount(f.creditScope);
      assert.equal(account?.reservedCredits, "30");
      assert.equal(account?.availableCredits, "970");
      assert.equal(account?.spentCredits, "0"); // Settlement is a separate production integration.
      await f.closeWorker();
      assert.ok(f.controls.closes.includes("1.0.0"));
    },
  );

  test(
    `${backend}: installed task requires its v1 path and real quote; disabling selection blocks new admission`,
    options,
    async (t) => {
      const f = await businessExecutionFixture(t, backend);
      const request = await f.prepareTask("unpriced");
      await assert.rejects(
        f.tasks.createTask(actor, request.command),
        /plugin_task_admission_required/,
      );
      assert.equal(f.controls.quotes, 0);
      assert.equal(await f.count("run_snapshots"), 0);
      assert.equal(await f.count("plugin_credit_reservations"), 0);
      await f.select("disabled");
      await assert.rejects(request.create());
      assert.equal(f.controls.quotes, 0);
      assert.equal(await f.count("run_snapshots"), 0);
      assert.equal(await f.count("plugin_credit_reservations"), 0);
      assert.equal(f.controls.executes.length, 0);
    },
  );

  test(
    `${backend}: actual factory profile mismatch is rejected before a Node execution owner can be opened`,
    options,
    async (t) => {
      const f = await businessExecutionFixture(t, backend);
      const accepted = await (await f.prepareTask("scope")).create();
      const run = await f.store.loadRunInSpace(accepted.binding);
      const admission = await f.extensions.loadPluginTaskAdmission(
        accepted.binding,
      );
      assert.ok(run);
      assert.ok(admission);
      const different = createInstalledPluginAgentVersionRuntimeFactory({
        defaultAgentVersionId: f.entry.base.version.agentVersionId,
        entries: [
          { ...f.entry, scope: { ...scope, profileId: "another-profile" } },
        ],
      });
      const actual = await different.create({
        tenantId: actor.tenantId,
        version: f.entry.version,
      });
      const setups = f.controls.setups.length;
      try {
        assert.throws(
          () =>
            installedPluginRunMaterialization({ run, admission, base: actual }),
          /installed_plugin_materialization_profile_mismatch/,
        );
        assert.equal(f.controls.setups.length, setups);
        assert.equal(f.controls.factories.length, 0);
        assert.equal(f.controls.executes.length, 0);
      } finally {
        await actual.close?.();
      }
    },
  );

  test(
    `${backend}: cold Worker reopens the original installed package and reconciles its receipt after upgrade and disable`,
    options,
    async (t) => {
      const f = await businessExecutionFixture(t, backend);
      const request = await f.prepareTask("recovery");
      const accepted = await request.create();
      const originalAdmission = await f.extensions.loadPluginTaskAdmission(
        accepted.binding,
      );
      const first = await f.openWorker({
        afterToolProviderResolved: async () => {
          throw new Error("fixture_owner_loss_after_provider_acceptance");
        },
      });
      assert.deepEqual(
        await first.worker.wake(),
        {
          kind: "retried",
          runId: accepted.binding.runId,
          code: "fixture_owner_loss_after_provider_acceptance",
        },
        JSON.stringify(f.controls.models),
      );
      assert.deepEqual(f.controls.executes, ["1.0.0"]);
      assert.equal(f.controls.outcomes.size, 1);
      await f.closeWorker();
      const upgrade = await f.upgrade();
      await f.select("disabled", upgrade.identity.packageDigest);
      const recovered = await f.openWorker();
      assert.deepEqual(await recovered.worker.wake(), {
        kind: "completed",
        runId: accepted.binding.runId,
      });
      assert.deepEqual(f.controls.executes, ["1.0.0"]);
      assert.ok(f.controls.reconciles.includes("1.0.0"));
      assert.ok(f.controls.setups.every((version) => version === "1.0.0"));
      assert.deepEqual(
        await f.extensions.loadPluginTaskAdmission(accepted.binding),
        originalAdmission,
      );
      const contexts = f.controls.factories as Array<{
        identity: { version: string; packageDigest: string };
      }>;
      assert.ok(contexts.length >= 2);
      assert.ok(
        contexts.every(
          (context) =>
            context.identity.version === "1.0.0" &&
            context.identity.packageDigest ===
              f.entry.registration.identity.packageDigest,
        ),
      );
      assert.equal(await f.count("plugin_credit_reservations"), 1);
      const forbidden = await f.prepareTask("after-disable");
      await assert.rejects(forbidden.create());
      assert.equal(await f.count("run_snapshots"), 1);
      assert.equal(f.controls.quotes, 1);
      await f.closeWorker();
    },
  );
}
