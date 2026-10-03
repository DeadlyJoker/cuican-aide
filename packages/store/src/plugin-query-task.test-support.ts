import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  ExtensionTaskApplicationService,
  type PluginQueryHostPort,
} from "@crewon/application";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";
import {
  actor,
  activateCommand,
  configurationServiceFixture,
  saveCommand,
} from "./extension-configuration-service.test-support.ts";
import { scope, timestamp, digest } from "./extension-store.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import { startExternalOperationFixtureRun } from "./external-operation-run.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";
export { actor, scope };
/** Real storage/use-case fixture; readiness here is explicit metadata, not an installed execution proof. */
export async function pluginQueryFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await configurationServiceFixture(t, backend);
  await f.seedDeployment();
  await f.service.saveConfiguration(actor, saveCommand);
  await f.service.setActivation(actor, activateCommand);
  const profile = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "query-profile",
  };
  const installations = f.first.parent.pluginInstallationStore();
  await installations.migrate();
  await f.first.store.migrateCredits();
  await f.first.store.migratePluginAdmissions();
  const recipe = installationRecipe("query-original", {
      scope: profile,
      actor,
      pluginId: scope.pluginId,
      version: "0.1.0",
    }),
    installed = await installations.recordInstalledPackage(recipe),
    enabled = await installations.commitSelection(
      selectionRecipe(installed.selection, "query-enable", { actor }),
    );
  const creditScope = {
    tenantId: actor.tenantId,
    principalId: actor.principalId,
    poolId: "query-fixture",
  };
  const credits = f.first.parent.pluginCreditStore();
  await credits.grant({
    scope: creditScope,
    grantId: "query-funding",
    credits: "100",
  });
  let quoteCalls = 0;
  const create = (
    extensionStore = f.first.store,
    runStore = f.first.parent,
    pluginQueryHost?: PluginQueryHostPort,
  ) =>
    new ExtensionTaskApplicationService({
      ...f.dependencies,
      store: runStore,
      extensions: extensionStore,
      operations: f.operations,
      ids: { nextId: () => randomUUID() },
      creditQuotes: {
        async quoteGeneration() {
          quoteCalls++;
          return {
            poolId: creditScope.poolId,
            priceRevision: 1,
            quotedCredits: "10",
          };
        },
      },
      ...(pluginQueryHost === undefined ? {} : { pluginQueryHost }),
    });
  const pin = parsePluginTaskAdmissionPin({
    ...actor,
    ...profile,
    pluginId: scope.pluginId,
    publisherId: recipe.package.publisherId,
    version: recipe.package.version,
    packageDigest: recipe.package.packageDigest,
    selectionRevision: enabled.selection.revision,
    contributionId: "studio",
    action: "image.generate",
    authorityEpoch: "query-epoch",
  });
  const generationThread = "query-generation";
  await seedThread(f.first.parent, { ...actor, threadId: generationThread });
  const generation = await create().createTaskFromPlugin(
    actor,
    {
      pluginId: scope.pluginId,
      threadId: generationThread,
      expectedThreadRevision: 1,
      idempotencyKey: "original",
      intent: { kind: "generate", input: { prompt: "Original generation" } },
    },
    pin,
  );
  const sourceAdmission = await f.first.store.loadPluginTaskAdmission(
    generation.binding,
  );
  assert.ok(sourceAdmission);
  await startExternalOperationFixtureRun(f.first.parent, generation.binding);
  const operationId = randomUUID();
  await f.operations.reserveExternalOperation({
    tenantId: actor.tenantId,
    runId: generation.binding.runId,
    bindingDigest: generation.binding.bindingDigest,
    operationId,
    executionId: "query-source-execution",
    idempotencyKey: "query-source-op",
    actionDigest: digest,
    requestDigest: digest,
    correlationId: operationId,
    createdAt: timestamp,
  });
  const host: PluginQueryHostPort = {
    async resolveRegistration({ source }) {
      assert.equal(source.admission.packageDigest, pin.packageDigest);
      return f.dependencies.catalog.resolve({
        pluginId: scope.pluginId,
        pluginVersion: pin.version,
      });
    },
    async evaluate({ source, expectedTarget }) {
      assert.deepEqual(expectedTarget, source.binding.target);
      return { outcome: "ready", target: source.binding.target };
    },
  };
  const command = (key = "query-task") => ({
    pluginId: scope.pluginId,
    threadId: "query-thread",
    expectedThreadRevision: 1,
    idempotencyKey: key,
    intent: {
      kind: "query" as const,
      sourceRunId: generation.binding.runId,
      operationId,
    },
  });
  await seedThread(f.first.parent, { ...actor, threadId: "query-thread" });
  const queryPin = parsePluginTaskAdmissionPin({
    ...pin,
    action: "image.query",
  });
  return {
    ...f,
    profile,
    installations,
    recipe,
    installed,
    enabled,
    creditScope,
    credits,
    pin,
    queryPin,
    sourceAdmission,
    generation,
    operationId,
    command,
    host,
    create,
    quoteCalls: () => quoteCalls,
  };
}
