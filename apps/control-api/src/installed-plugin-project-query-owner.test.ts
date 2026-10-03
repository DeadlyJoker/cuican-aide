import assert from "node:assert/strict";
import test from "node:test";
import { parseProjectQueryLink } from "@crewon/domain";
import { assertPluginUiHostServiceAvailability } from "@crewon/plugin-host";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import {
  installedProjectQueryFixture,
  actor,
  creditScope,
  queryAction,
} from "./installed-plugin-project-query-owner.test-support.ts";
import { deferred } from "./installed-plugin-task-action-owner.test-support.ts";
import { InstalledPluginProjectQueryOwner } from "./installed-plugin-project-query-owner.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const options = {
    skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 25_000,
  };
  test(
    `${backend} independent installed business UI queries original paid A through current actual Node B and replays exactly one free query Run`,
    options,
    async (t) => {
      const f = await installedProjectQueryFixture(t, backend);
      assert.equal(f.source.descriptor.entrypoints.node, null);
      assert.notEqual(f.oldPin.packageDigest, f.target.packageDigest);
      assert.equal(f.extensions.projectGenerationVersion, undefined);
      assert.equal(f.extensions.projectGenerationPublicationVersion, undefined);
      assertPluginUiHostServiceAvailability({
        scope: f.profile,
        candidate: {
          descriptor: f.source.descriptor,
          packageDigest: f.source.packageDigest,
        },
        hostUiServices: f.owner.hostUiServices,
      });
      const before = await f.counts(),
        account = await f.credits.getAccount(creditScope),
        quoteCalls = f.nodeState.quoteCalls;
      const output = await f.invoke();
      const result = f.state.accepted[0]!,
        submitted = f.state.submissions[0]!;
      assert.deepEqual(output, {
        disposition: "committed",
        threadId: result.binding.threadId,
        threadRevision: result.turn.threadState.revision,
        runId: result.binding.runId,
        messageId: result.turn.messages[0]!.messageId,
        configurationRevision: result.binding.configurationRevision,
      });
      assert.equal(f.state.lastContext!.package.pluginId, f.sourceId);
      assert.equal(f.state.lastContext!.action, queryAction);
      assert.equal(submitted.sourcePin.pluginId, f.sourceId);
      assert.equal(
        submitted.executionPin.packageDigest,
        f.target.packageDigest,
      );
      assert.equal(submitted.executionPin.version, "0.2.0");
      assert.equal(submitted.executionPin.action, "image.query");
      assert.deepEqual(submitted.command.intent, {
        kind: "query",
        sourceRunId: f.generation.binding.runId,
        operationId: f.operationId,
      });
      assert.notEqual(
        submitted.command.idempotencyKey,
        f.request.idempotencyKey,
      );
      const admission = await f.extensions.loadPluginQueryTaskAdmission(
        result.binding,
      );
      assert.ok(admission);
      assert.equal(admission.packageDigest, f.target.packageDigest);
      assert.equal(admission.source.packageDigest, f.oldPin.packageDigest);
      assert.equal(admission.source.version, "0.1.0");
      assert.equal(
        result.binding.configurationDigest,
        f.generation.binding.configurationDigest,
      );
      assert.deepEqual(result.binding.target, f.generation.binding.target);
      assert.deepEqual(result.binding.source, {
        runId: f.generation.binding.runId,
        bindingDigest: f.generation.binding.bindingDigest,
        operationId: f.operationId,
      });
      const link = parseProjectQueryLink(
        await f.extensions.loadProjectQueryLink(result.binding),
        extensionStoreDigester,
      );
      assert.equal(link.generationLinkDigest, f.generationLink.contentDigest);
      assert.deepEqual(link.reference, f.reference);
      assert.deepEqual(link.publication, f.publication);
      assert.deepEqual(link.sourcePin, submitted.sourcePin);
      assert.deepEqual(link.executionPin, submitted.executionPin);
      assert.ok(f.state.historicalVersions.length > 0);
      assert.ok(
        f.state.historicalVersions.every((version) => version === "0.1.0"),
      );
      const after = await f.counts();
      const writes = new Set([
        "messages",
        "run_snapshots",
        "extension_run_bindings",
        "plugin_query_task_admissions",
        "creative_project_query_links",
      ]);
      for (const table of Object.keys(before))
        assert.equal(
          after[table],
          before[table]! + (writes.has(table) ? 1 : 0),
          table,
        );
      assert.equal(f.nodeState.quoteCalls, quoteCalls);
      assert.deepEqual(await f.credits.getAccount(creditScope), account);
      assert.equal(f.nodeState.setups, 1);
      assert.equal(f.nodeState.calls, 1);
      assert.equal(f.nodeState.disposals, 1);
      await f.service.closeMount(actor, { mountRef: f.lease.mountRef });
      const selected = await f.ledger.loadSelection({
        scope: f.profile,
        pluginId: f.sourceId,
      });
      assert.ok(selected);
      const reopened = await f.service.openMount(actor, {
        pluginId: f.sourceId,
        contributionId: "workbench",
        expectedSelectionRevision: selected.revision,
        expectedPackageDigest: f.source.packageDigest,
      });
      assert.deepEqual(await f.invoke(f.request, queryAction, reopened), {
        ...(output as object),
        disposition: "replayed",
      });
      assert.deepEqual(await f.counts(), after);
      assert.equal(f.nodeState.quoteCalls, quoteCalls);
      assert.deepEqual(await f.credits.getAccount(creditScope), account);
    },
  );

  for (const change of [
    "source-policy",
    "target-policy",
    "source-package",
    "target-package",
    "source-selection",
    "target-selection",
    "mount-close",
    "owner-close",
    "request-abort",
  ] as const)
    test(
      `${backend} ${change} while original query readiness awaits admits no query and leaves original funds and generation unchanged`,
      options,
      async (t) => {
        const f = await installedProjectQueryFixture(t, backend);
        const entered = deferred(),
          release = deferred();
        f.nodeState.queryEntered = entered.resolve;
        f.nodeState.queryGate = release.promise;
        const before = await f.counts(),
          account = await f.credits.getAccount(creditScope),
          quotes = f.nodeState.quoteCalls;
        const pending = f.invoke();
        void pending.catch(() => {});
        await entered.promise;
        let closing: Promise<void> | undefined;
        if (change === "source-policy") f.state.sourceDenied = true;
        else if (change === "target-policy") f.state.targetDenied = true;
        else if (change === "source-package")
          f.state.sourcePackageAllowed = false;
        else if (change === "target-package")
          f.state.targetPackageAllowed = false;
        else if (change === "source-selection") await f.disable("source");
        else if (change === "target-selection") await f.disable("target");
        else if (change === "mount-close")
          await f.service.closeMount(actor, { mountRef: f.lease.mountRef });
        else if (change === "owner-close") closing = f.owner.close();
        else f.state.request.abort(new Error("project-query-request-aborted"));
        release.resolve();
        await assert.rejects(pending);
        await closing;
        assert.deepEqual(await f.counts(), before);
        assert.deepEqual(await f.credits.getAccount(creditScope), account);
        assert.equal(f.nodeState.quoteCalls, quotes);
        assert.equal(f.state.accepted.length, 0);
        assert.equal(f.nodeState.disposals, 1);
      },
    );

  test(
    `${backend} confirmed query COMMIT stays acknowledged after actual close and withdrawal`,
    options,
    async (t) => {
      const f = await installedProjectQueryFixture(t, backend);
      let closing: Promise<void> | undefined;
      f.state.afterCommit = async () => {
        assert.equal(await f.count("creative_project_query_links"), 1);
        await f.service.closeMount(actor, { mountRef: f.lease.mountRef });
        await f.disable("source");
        await f.disable("target");
        f.state.sourceDenied = true;
        f.state.targetDenied = true;
        f.state.request.abort(new Error("closed-after-query-commit"));
        closing = f.owner.close();
      };
      assert.equal(
        ((await f.invoke()) as { disposition: string }).disposition,
        "committed",
      );
      await closing;
      assert.equal(f.state.accepted.length, 1);
      assert.equal(await f.count("creative_project_query_links"), 1);
      assert.equal(await f.count("creative_project_generation_links"), 1);
      assert.equal(f.nodeState.quoteCalls, 1);
      assert.equal(f.nodeState.disposals, 1);
    },
  );

  test(
    `${backend} archived historical input remains queryable without changing saved generation or query configuration`,
    options,
    async (t) => {
      const f = await installedProjectQueryFixture(t, backend);
      await f.projectService.setProjectState(actor, {
        projectId: f.reference.projectId,
        expectedProjectRevision: f.concept.project.revision,
        state: "archived",
        idempotencyKey: "query-archive-history",
      });
      assert.equal(
        ((await f.invoke()) as { disposition: string }).disposition,
        "committed",
      );
      assert.deepEqual(
        await f.first.store.loadProjectGenerationLink(f.generation.binding),
        f.generationLink,
      );
    },
  );
}

test("query owner rejects mismatched real task and issuer pairs; reserved unknown actions cannot fall through", async (t) => {
  const f = await installedProjectQueryFixture(t);
  const other = await installedProjectQueryFixture(t);
  assert.throws(
    () =>
      new InstalledPluginProjectQueryOwner({
        ...f.dependencies,
        taskOwner: other.taskOwner,
      }),
    /configuration_invalid/u,
  );
  assert.throws(
    () =>
      new InstalledPluginProjectQueryOwner({
        ...f.dependencies,
        committedTasks: other.committedTasks,
      }),
    /configuration_invalid/u,
  );
  const before = await f.counts();
  await assert.rejects(
    f.invoke(
      f.request,
      "crewon.project-generation-queries.v1.unknown" as typeof queryAction,
    ),
    /action_invalid/u,
  );
  await assert.rejects(
    f.invoke({
      ...f.request,
      sourceRunId: f.generation.binding.runId,
    } as PluginUiJsonValue),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, "plugin_ui_unavailable");
      assert.equal(
        ((error as Error).cause as { code: string }).code,
        "plugin_ui_fields_invalid",
      );
      return true;
    },
  );
  assert.equal(f.nodeState.setups, 0);
  assert.deepEqual(await f.counts(), before);
});

import type { PluginUiJsonValue } from "@crewon/application";
