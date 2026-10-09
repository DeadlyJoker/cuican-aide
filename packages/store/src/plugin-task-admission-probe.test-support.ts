import type { CommitExtensionTurnInput } from "@crewon/application";
import {
  createExtensionCreditAdmission,
  parsePluginTaskAdmission,
} from "@crewon/domain";
import { extensionFixture, scope } from "./extension-store.test-support.ts";
import { extensionTurnInput } from "./extension-turn.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";

/** Real persisted Turn and personal hold; the fixed amount and package identity are test fixtures. */
export async function prepareProbeAdmission(
  f: Awaited<ReturnType<typeof extensionFixture>>,
): Promise<CommitExtensionTurnInput> {
  await f.seed();
  const base = extensionTurnInput();
  await f.prepare({
    ...base,
    commit: {
      ...base.turn.run,
      tenantId: base.turn.tenantId,
      idempotency: base.turn.idempotency,
    },
  });
  const actor = {
    tenantId: scope.tenantId,
    spaceId: scope.spaceId,
    actorId: base.binding.actorId,
    principalId: "probe-payer",
  };
  const profile = {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    profileId: "probe-profile",
  };
  const installs = f.first.parent.pluginInstallationStore();
  await installs.migrate();
  const recipe = installationRecipe("probe-package", {
    scope: profile,
    actor,
    pluginId: scope.pluginId,
  });
  const installed = await installs.recordInstalledPackage(recipe);
  const enabled = await installs.commitSelection(
    selectionRecipe(installed.selection, "probe-enable", { actor }),
  );
  await f.first.store.migrateCredits();
  await f.first.store.migratePluginAdmissions();
  const creditScope = {
    tenantId: actor.tenantId,
    principalId: actor.principalId,
    poolId: "probe-fixture-pool",
  };
  await f.first.parent
    .pluginCreditStore()
    .grant({ scope: creditScope, grantId: "probe-funding", credits: "100" });
  const input: CommitExtensionTurnInput = {
    ...base,
    pluginAdmission: parsePluginTaskAdmission({
      schemaVersion: "crewon.plugin-task-admission.v1",
      ...profile,
      pluginId: recipe.package.pluginId,
      publisherId: recipe.package.publisherId,
      version: recipe.package.version,
      packageDigest: recipe.package.packageDigest,
      selectionRevision: enabled.selection.revision,
      principalId: actor.principalId,
      actorId: actor.actorId,
      contributionId: "workbench",
      action: "image.generate",
      authorityEpoch: "fixture-probe-epoch",
      runId: base.binding.runId,
      threadId: base.binding.threadId,
      extensionBindingDigest: base.binding.bindingDigest,
      requestDigest: base.receipt.requestDigest,
      idempotencyKey: base.receipt.idempotencyKey,
    }),
    creditAdmission: createExtensionCreditAdmission(
      {
        binding: base.binding,
        receipt: base.receipt,
        principalId: actor.principalId,
        poolId: creditScope.poolId,
        priceRevision: 1,
        quotedCredits: "30",
      },
      extensionStoreDigester,
    ),
  };
  return input;
}

export async function seedProbeAdmission(
  f: Awaited<ReturnType<typeof extensionFixture>>,
): Promise<CommitExtensionTurnInput> {
  const input = await prepareProbeAdmission(f);
  await f.first.store.commitExtensionTurn(input);
  return input;
}
