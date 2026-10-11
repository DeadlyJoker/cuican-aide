import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ExtensionTaskApplicationService } from "@crewon/application";
import { createPluginCompositionLock } from "@crewon/contracts/plugins";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";
import { actor } from "../../../packages/store/src/extension-configuration-service.test-support.ts";
import { extensionStoreDigester as digester } from "../../../packages/store/src/extension-store-records.ts";
import { seedThread } from "../../../packages/store/src/thread-store-conformance.test-support.ts";
import { startExternalOperationFixtureRun } from "../../../packages/store/src/external-operation-run.test-support.ts";
import { selectionRecipe } from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import {
  installedResolverFixture,
  signal,
} from "./installed-plugin-runtime-resolver.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  test(
    `${backend}: actual Worker resolver restores the query's original provider graph under current observation authority and denies generation`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await installedResolverFixture(t, {
        backend,
        composition: true,
      });
      assert.ok(f.originalComposition && f.compositions && f.providerPackage);
      const admission = await f.first.store.loadPluginTaskAdmission(
        f.task.binding,
      );
      assert.ok(admission);
      await startExternalOperationFixtureRun(f.first.parent, f.task.binding);
      const operationId = randomUUID();
      await f.operations.reserveExternalOperation({
        tenantId: actor.tenantId,
        runId: f.task.binding.runId,
        bindingDigest: f.task.binding.bindingDigest,
        operationId,
        executionId: "query-original-operation",
        idempotencyKey: "query-original-operation",
        actionDigest: digester.sha256("action"),
        requestDigest: digester.sha256("request"),
        correlationId: operationId,
        createdAt: f.run.createdAt,
      });
      const providerSelection = await f.installations.loadSelection({
        scope: f.profile,
        pluginId: f.providerPackage.pluginId,
      });
      assert.ok(providerSelection);
      await f.installations.commitSelection(
        selectionRecipe(providerSelection, "worker-query-disable-provider", {
          actor,
          state: "disabled",
        }),
      );
      const next = createPluginCompositionLock(
        {
          schemaVersion: f.originalComposition.schemaVersion,
          scope: {
            ...f.originalComposition.scope,
            authorityEpoch: "worker-query-current-epoch",
          },
          revision: 2,
          nodes: f.originalComposition.nodes
            .filter((node) => node.pluginId === admission.pluginId)
            .map((node) => ({
              ...node,
              requires: node.requires.filter(
                (requirement) => requirement.service === "crewon.execution",
              ),
            })),
          hostServices: f.originalComposition.hostServices,
        },
        digester,
      );
      await f.compositions.commit({
        scope: next.scope,
        actor,
        lock: next,
        expectedRevision: 1,
      });
      const threadId = "worker-original-composed-query";
      await seedThread(f.first.parent, { ...actor, threadId });
      // Named metadata preflight fixture only. Package loading below uses the actual installed ESM graph and resolver.
      const registration = f.base.extensions![0]!.registration;
      const tasks = new ExtensionTaskApplicationService({
        ...f.dependencies,
        store: f.first.parent,
        extensions: f.first.store,
        operations: f.operations,
        ids: { nextId: () => randomUUID() },
        pluginCompositions: f.compositions,
        pluginQueryHost: {
          async resolveRegistration({ source }) {
            assert.deepEqual(source.admission, admission);
            return registration;
          },
          async evaluate({ expectedTarget }) {
            assert.deepEqual(expectedTarget, f.task.binding.target);
            return { outcome: "ready", target: expectedTarget };
          },
        },
      });
      const query = await tasks.createQueryTaskFromPlugin(
        actor,
        {
          pluginId: admission.pluginId,
          threadId,
          expectedThreadRevision: 1,
          idempotencyKey: "worker-composed-query",
          intent: { kind: "query", sourceRunId: admission.runId, operationId },
        },
        parsePluginTaskAdmissionPin({
          ...actor,
          ...f.profile,
          pluginId: admission.pluginId,
          publisherId: admission.publisherId,
          version: admission.version,
          packageDigest: admission.packageDigest,
          selectionRevision: admission.selectionRevision,
          contributionId: admission.contributionId,
          action: "image.query",
          authorityEpoch: next.scope.authorityEpoch,
        }),
      );
      const run = await f.first.parent.loadRunInSpace(query.binding);
      assert.ok(run);
      let currentScope = next.scope;
      const resolver = f.compositionResolver({
        compositionExecution: {
          hostServiceMetadata: [],
          assertCurrentAuthority: () => currentScope,
        },
      });
      const lease = await resolver.acquire({
        run,
        base: f.base,
        purpose: "observe",
        signal: signal(),
      });
      assert.ok(lease);
      assert.deepEqual(
        f.controls.records.filter((record) =>
          ["provider-setup", "setup", "factory"].includes(record),
        ),
        ["provider-setup", "setup", "factory"],
      );
      assert.equal(
        (f.controls.contexts.at(-1) as { run: { source: { runId: string } } })
          .run.source.runId,
        admission.runId,
      );
      const beforeExecute = f.controls.records.length;
      await assert.rejects(
        lease.resource.execute(f.execution(run), signal()),
        /installed_plugin_runtime_policy_mismatch/u,
      );
      assert.equal(
        f.controls.records.slice(beforeExecute).includes("execute"),
        false,
      );
      lease.release();
      currentScope = { ...next.scope, profileId: "foreign-profile" };
      await assert.rejects(
        resolver.acquire({
          run,
          base: f.base,
          purpose: "observe",
          signal: signal(),
        }),
        /installed_plugin_composition_authority_changed/u,
      );
      await resolver.close();
      assert.ok(f.controls.records.includes("runtime-closed"));
      assert.ok(f.controls.records.includes("node-dispose"));
      assert.ok(f.controls.records.includes("provider-dispose"));
      assert.equal(await f.count("plugin_credit_reservations"), 1);
      assert.equal(await f.count("run_snapshots"), 2);
    },
  );
}
