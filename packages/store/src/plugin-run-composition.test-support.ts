import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  createPluginCompositionLock,
  PLUGIN_COMPOSITION_LOCK_SCHEMA,
  type PluginCompositionNode,
} from "@crewon/contracts/plugins";
import {
  createExtensionRunBinding,
  createExtensionCreditAdmission,
  parsePluginTaskAdmission,
} from "@crewon/domain";
import { prepareProbeAdmission } from "./plugin-task-admission-probe.test-support.ts";
import { extensionFixture } from "./extension-store.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
export async function composedTurnFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await extensionFixture(t, backend);
  const base = await prepareProbeAdmission(f);
  const pin = base.pluginAdmission!;
  const scope = {
    tenantId: pin.tenantId,
    spaceId: pin.spaceId,
    profileId: pin.profileId,
  };
  const actor = {
    tenantId: pin.tenantId,
    spaceId: pin.spaceId,
    principalId: pin.principalId,
    actorId: pin.actorId,
  };
  const installations = f.first.parent.pluginInstallationStore();
  const provider = await installations.recordInstalledPackage(
    installationRecipe("composition-provider-install", {
      scope,
      actor,
      pluginId: "example.provider",
    }),
  );
  const enabled = await installations.commitSelection(
    selectionRecipe(provider.selection, "composition-provider-enable", {
      actor,
    }),
  );
  const nodes: readonly PluginCompositionNode[] = [
    {
      pluginId: pin.pluginId,
      publisherId: pin.publisherId,
      version: pin.version,
      packageDigest: pin.packageDigest,
      selectionRevision: pin.selectionRevision,
      hostApi: "crewon.plugin-host.v1",
      requires: [{ service: "story.source", apiVersion: "1", optional: false }],
      provides: [],
    },
    {
      pluginId: provider.package.pluginId,
      publisherId: provider.package.publisherId,
      version: provider.package.version,
      packageDigest: provider.package.packageDigest,
      selectionRevision: enabled.selection.revision,
      hostApi: "crewon.plugin-host.v1",
      requires: [],
      provides: [{ service: "story.source", apiVersion: "1" }],
    },
  ];
  const composition = installations.compositionStore!();
  await composition.migrate();
  const makeLock = (
    revision: number,
    nextNodes = nodes,
    epoch = pin.authorityEpoch,
  ) =>
    createPluginCompositionLock(
      {
        schemaVersion: PLUGIN_COMPOSITION_LOCK_SCHEMA,
        scope: { ...scope, authorityEpoch: epoch },
        revision,
        nodes: nextNodes,
        hostServices: [],
      },
      extensionStoreDigester,
    );
  const lock = makeLock(1);
  await composition.commit({
    scope: lock.scope,
    actor,
    lock,
    expectedRevision: null,
  });
  const binding = createExtensionRunBinding(
    {
      ...base.binding,
      schemaVersion: "crewon.extension-run-binding.v1",
      composition: {
        profileId: scope.profileId,
        authorityEpoch: lock.scope.authorityEpoch,
        revision: lock.revision,
        lockDigest: lock.lockDigest,
      },
    },
    extensionStoreDigester,
  );
  const input = {
    ...base,
    binding,
    pluginAdmission: parsePluginTaskAdmission({
      ...pin,
      extensionBindingDigest: binding.bindingDigest,
    }),
    creditAdmission: createExtensionCreditAdmission(
      {
        binding,
        receipt: base.receipt,
        principalId: pin.principalId,
        poolId: base.creditAdmission!.reservation.scope.poolId,
        priceRevision: 1,
        quotedCredits: "30",
      },
      extensionStoreDigester,
    ),
  };
  const readOriginal = () =>
    composition.loadLock({ scope, lockDigest: lock.lockDigest });
  const assertNoRun = async () => {
    for (const table of [
      "messages",
      "model_history_items",
      "run_snapshots",
      "extension_run_bindings",
      "outbox",
      "work_items",
      "plugin_task_admissions",
      "plugin_credit_reservations",
    ])
      assert.equal(await f.count(table), 0, table);
  };
  return {
    ...f,
    base,
    input,
    pin,
    scope,
    actor,
    installations,
    provider,
    enabled,
    composition,
    lock,
    makeLock,
    readOriginal,
    assertNoRun,
  };
}
