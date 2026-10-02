import assert from "node:assert/strict";
import test from "node:test";
import type {
  CreateExtensionTaskCommand,
  PluginUiJsonValue,
} from "@crewon/application";
import {
  actor,
  businessExecutionFixture,
  scope,
} from "./installed-plugin-business-execution.integration.test-support.ts";
import { businessUiFixture } from "./installed-plugin-ui-business-execution.integration.test-support.ts";
import { professionalProviderFixture } from "./installed-plugin-ui-business-execution.provider.test-support.ts";

function externalPackageSources() {
  const packageDirectory = process.env.CREWON_TEST_BUSINESS_PLUGIN_V1_DIR;
  const upgradePackageDirectory =
    process.env.CREWON_TEST_BUSINESS_PLUGIN_V2_DIR;
  assert.ok(
    packageDirectory,
    "Worker test bootstrap must build the external SDK v1 example before consumers run",
  );
  assert.ok(
    upgradePackageDirectory,
    "Worker test bootstrap must build the external SDK v2 example before consumers run",
  );
  return { packageDirectory, upgradePackageDirectory };
}

type TaskReceipt = {
  disposition: "committed" | "replayed";
  runId: string;
  threadId: string;
  threadRevision: number;
  messageId: string;
  configurationRevision: number;
};

function receipt(input: PluginUiJsonValue): TaskReceipt {
  assert.ok(input && typeof input === "object" && !Array.isArray(input));
  const value = input as Readonly<Record<string, PluginUiJsonValue>>;
  assert.equal(typeof value.runId, "string");
  assert.equal(typeof value.threadId, "string");
  assert.ok(
    value.disposition === "committed" || value.disposition === "replayed",
  );
  return value as TaskReceipt;
}

function taskUiData(command: CreateExtensionTaskCommand): PluginUiJsonValue {
  assert.equal(command.intent.kind, "generate");
  if (command.intent.kind !== "generate")
    throw new Error("fixture_generate_required");
  return {
    threadId: command.threadId,
    expectedThreadRevision: command.expectedThreadRevision,
    idempotencyKey: command.idempotencyKey,
    input: command.intent.input,
  };
}

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    timeout: 60_000,
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
  };
  test(
    `${backend}: one externally built SDK package mounts real UI and replays its paid task through the owned Worker`,
    options,
    async (t) => {
      const provider = await professionalProviderFixture(t);
      const f = await businessExecutionFixture(t, backend, {
        ...externalPackageSources(),
        configurationParameters: {
          organization: "Fixture company",
          providerBaseUrl: provider.baseUrl,
        },
      });
      const ui = await businessUiFixture(t, f);
      const request = await f.prepareTask("external-ui");
      const lease = await ui.mount(taskUiData(request.command));
      assert.equal(
        lease.packageDigest,
        f.entry.registration.identity.packageDigest,
      );
      assert.equal(ui.identity.packageDigest, lease.packageDigest);
      assert.equal(
        ui.root
          .querySelector("[data-independent-plugin-version]")
          ?.getAttribute("data-independent-plugin-version"),
        "1.0.0",
      );
      assert.equal(
        provider.requests().length,
        0,
        "Node/UI setup does not call the supplier",
      );
      assert.ok(
        ui.requests.some((path) =>
          path.includes(`/assets/${lease.descriptor.entrypoints.ui!.path}`),
        ),
      );
      await assert.rejects(
        ui.readAsset(lease, "business.json"),
        /plugin_ui_asset_unavailable/u,
      );
      ui.loseNextTaskResponse();
      await assert.rejects(ui.click());
      assert.match(
        ui.root.querySelector("output")!.textContent,
        /任务未确认受理/u,
      );
      assert.equal(f.controls.quotes, 1);
      assert.equal(await f.count("run_snapshots"), 1);
      assert.equal(await f.count("plugin_credit_reservations"), 1);
      assert.equal(await f.count("plugin_task_admissions"), 1);
      const committed = receipt(ui.committedResponses[0]!);
      const replayed = receipt(await ui.click());
      assert.equal(replayed.disposition, "replayed");
      assert.deepEqual({ ...replayed, disposition: "committed" }, committed);
      assert.equal(f.controls.quotes, 1);
      assert.equal(await f.count("run_snapshots"), 1);
      const admission = await f.extensions.loadPluginTaskAdmission({
        ...actor,
        runId: replayed.runId,
      });
      assert.ok(admission);
      assert.equal(admission.profileId, scope.profileId);
      assert.equal(admission.principalId, actor.principalId);
      assert.equal(admission.packageDigest, lease.packageDigest);
      assert.equal(admission.selectionRevision, lease.selectionRevision);
      assert.equal(admission.contributionId, lease.contributionId);
      assert.equal(admission.action, "report.generate");
      assert.equal(admission.authorityEpoch, ui.epoch.value);
      const binding = await f.extensions.loadExtensionRunBinding({
        ...actor,
        runId: replayed.runId,
      });
      assert.ok(binding);
      const paid = await f.extensions.loadExtensionCreditAdmission(binding);
      assert.ok(paid);
      assert.equal(paid.reservation.scope.principalId, actor.principalId);
      assert.equal(paid.reservation.quotedCredits, "30");
      const defaultTurn = await f.defaultTask();
      const worker = await f.openWorker();
      const results = [await worker.worker.wake(), await worker.worker.wake()];
      assert.ok(
        results.every((result) => result.kind === "completed"),
        JSON.stringify(results),
      );
      assert.ok(
        results.some(
          (result) =>
            result.kind === "completed" && result.runId === replayed.runId,
        ),
      );
      assert.equal((await worker.worker.wake()).kind, "idle");
      assert.deepEqual(
        provider.requests().map((item) => item.method),
        ["POST"],
      );
      assert.equal(provider.reports().length, 1);
      assert.equal(provider.reports()[0]!.pluginVersion, "1.0.0");
      const submitted = JSON.parse(provider.requests()[0]!.body!) as Record<
        string,
        unknown
      >;
      assert.deepEqual(Object.keys(submitted).sort(), [
        "executionId",
        "organization",
        "pluginVersion",
        "subject",
      ]);
      assert.equal(submitted.organization, "Fixture company");
      const messages = await f.store.listMessages(binding, 0, 100);
      assert.match(
        JSON.stringify(messages.at(-1)?.content),
        /answer:professional:1\.0\.0:Fixture company/u,
      );
      const defaultMessages = await f.store.listMessages(
        {
          tenantId: actor.tenantId,
          threadId: defaultTurn.threadState.threadId,
        },
        0,
        100,
      );
      assert.match(
        JSON.stringify(defaultMessages.at(-1)?.content),
        /original-default-answer/u,
      );
      assert.equal(
        (
          await f.store.loadActiveAgentVersionRelease({
            tenantId: actor.tenantId,
          })
        )?.bundle.defaultAgentVersionId,
        f.entry.base.version.agentVersionId,
      );
      assert.equal(
        (await f.credits.getAccount(f.creditScope))?.reservedCredits,
        "30",
      );
      assert.equal(await f.count("plugin_credit_reservations"), 1);
      assert.deepEqual(
        await f.extensions.loadPluginTaskAdmission({
          ...actor,
          runId: replayed.runId,
        }),
        admission,
      );
      assert.equal(ui.outputs.length, 1);
      assert.equal(ui.diagnostics.length, 0);
      await f.closeWorker();
      await ui.close();
      await assert.rejects(
        ui.service.validateMount(actor, { mountRef: lease.mountRef }),
        /plugin_ui_mount_unavailable/u,
      );
    },
  );

  test(
    `${backend}: the same UI package preserves original paid Run recovery after provider restart, upgrade and disable`,
    options,
    async (t) => {
      const provider = await professionalProviderFixture(t);
      const f = await businessExecutionFixture(t, backend, {
        ...externalPackageSources(),
        configurationParameters: {
          organization: "Fixture company",
          providerBaseUrl: provider.baseUrl,
        },
      });
      const ui = await businessUiFixture(t, f);
      const request = await f.prepareTask("external-recovery");
      const lease = await ui.mount(taskUiData(request.command));
      const accepted = receipt(await ui.click());
      assert.equal(accepted.disposition, "committed");
      // Closing the actual page revokes its UI lease; the paid background Run remains owned by Worker.
      await ui.stop();
      const original = await f.extensions.loadPluginTaskAdmission({
        ...actor,
        runId: accepted.runId,
      });
      const first = await f.openWorker({
        afterToolProviderResolved: async () => {
          throw new Error(
            "fixture_sdk_owner_lost_after_durable_provider_receipt",
          );
        },
      });
      assert.deepEqual(await first.worker.wake(), {
        kind: "retried",
        runId: accepted.runId,
        code: "fixture_sdk_owner_lost_after_durable_provider_receipt",
      });
      assert.equal(provider.reports().length, 1);
      assert.deepEqual(
        provider.requests().map((item) => item.method),
        ["POST"],
      );
      await f.closeWorker();
      await provider.restart();
      assert.equal(
        provider.reports().length,
        1,
        "supplier receipt survives reopening its database",
      );
      const upgrade = await f.upgrade();
      assert.equal(upgrade.identity.version, "2.0.0");
      assert.notEqual(upgrade.identity.packageDigest, lease.packageDigest);
      await f.select("disabled", upgrade.identity.packageDigest);
      await assert.rejects(
        ui.service.validateMount(actor, { mountRef: lease.mountRef }),
      );
      const fresh = await f.prepareTask("external-disabled");
      await assert.rejects(ui.mount(taskUiData(fresh.command)));
      assert.equal(await f.count("run_snapshots"), 1);
      assert.equal(await f.count("plugin_credit_reservations"), 1);
      assert.equal(f.controls.quotes, 1);
      const recovered = await f.openWorker();
      assert.deepEqual(await recovered.worker.wake(), {
        kind: "completed",
        runId: accepted.runId,
      });
      assert.deepEqual(
        provider.requests().map((item) => item.method),
        ["POST", "GET"],
      );
      assert.equal(provider.reports().length, 1);
      assert.equal(provider.reports()[0]!.pluginVersion, "1.0.0");
      assert.deepEqual(
        await f.extensions.loadPluginTaskAdmission({
          ...actor,
          runId: accepted.runId,
        }),
        original,
      );
      const binding = await f.extensions.loadExtensionRunBinding({
        ...actor,
        runId: accepted.runId,
      });
      assert.ok(binding);
      const messages = await f.store.listMessages(binding, 0, 100);
      assert.match(
        JSON.stringify(messages.at(-1)?.content),
        /professional:1\.0\.0:Fixture company/u,
      );
      assert.doesNotMatch(
        JSON.stringify(messages.at(-1)?.content),
        /professional:2\.0\.0/u,
      );
      assert.equal((await recovered.worker.wake()).kind, "idle");
      await f.closeWorker();
      await ui.close();
    },
  );
}
