import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  ApplicationError,
  ExtensionTaskApplicationService,
  type ExtensionCreditQuotePort,
} from "@crewon/application";
import { parsePluginTaskAdmissionPin } from "@crewon/domain";
import {
  actor,
  activateCommand,
  configurationServiceFixture,
  saveCommand,
} from "./extension-configuration-service.test-support.ts";
import { scope } from "./extension-store.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend} host-derived plugin task uses original Turn and freezes personal quote/provenance through replay`,
    { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
    async (t) => {
      const f = await configurationServiceFixture(t, backend);
      await f.seedDeployment();
      await f.service.saveConfiguration(actor, saveCommand);
      await f.service.setActivation(actor, activateCommand);
      const threadId = "installed-plugin-app-thread";
      await seedThread(f.first.parent, { ...actor, threadId });
      const profile = {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        profileId: "installed-plugin-app-profile",
      };
      const installs = f.first.parent.pluginInstallationStore();
      await installs.migrate();
      const recipe = installationRecipe("installed-app-install", {
        scope: profile,
        actor,
        pluginId: scope.pluginId,
      });
      const installed = await installs.recordInstalledPackage(recipe);
      const enabled = await installs.commitSelection(
        selectionRecipe(installed.selection, "installed-app-enable", { actor }),
      );
      await f.first.store.migrateCredits();
      await f.first.store.migratePluginAdmissions();
      const creditScope = {
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        poolId: "installed-app-fixture-pool",
      };
      const credits = f.first.parent.pluginCreditStore();
      // Test-only funding/quote; the production service still requires its real billing authority.
      await credits.grant({
        scope: creditScope,
        grantId: "installed-app-fixture-funding",
        credits: "100",
      });
      let quoteCalls = 0;
      const quotes: ExtensionCreditQuotePort = {
        async quoteGeneration(input) {
          assert.equal(input.actor.principalId, actor.principalId);
          quoteCalls++;
          return {
            poolId: creditScope.poolId,
            priceRevision: 7,
            quotedCredits: "23",
          };
        },
      };
      const create = (creditQuotes?: ExtensionCreditQuotePort) =>
        new ExtensionTaskApplicationService({
          ...f.dependencies,
          store: f.first.parent,
          extensions: f.first.store,
          operations: f.operations,
          ids: { nextId: () => randomUUID() },
          ...(creditQuotes === undefined ? {} : { creditQuotes }),
        });
      const pin = parsePluginTaskAdmissionPin({
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
        authorityEpoch: "fixture-plugin-epoch",
      });
      const command = {
        pluginId: scope.pluginId,
        threadId,
        expectedThreadRevision: 1,
        idempotencyKey: "installed-app-generation",
        intent: {
          kind: "generate" as const,
          input: {
            prompt: "A concept image from an independently installed plugin.",
          },
        },
      };
      const accepted = await create(quotes).createTaskFromPlugin(
        actor,
        command,
        pin,
      );
      assert.equal(accepted.run.disposition, "committed");
      assert.equal(quoteCalls, 1);
      assert.equal(
        accepted.creditAdmission?.reservation.scope.principalId,
        actor.principalId,
      );
      assert.equal(accepted.creditAdmission?.reservation.priceRevision, 7);
      assert.equal(accepted.creditAdmission?.reservation.quotedCredits, "23");
      const persisted = await f.first.store.loadPluginTaskAdmission(
        accepted.binding,
      );
      assert.equal(persisted?.packageDigest, pin.packageDigest);
      assert.equal(
        persisted?.extensionBindingDigest,
        accepted.binding.bindingDigest,
      );
      assert.equal(persisted?.principalId, actor.principalId);
      assert.equal(
        (await f.first.parent.listMessages({ ...actor, threadId }, 0, 10))
          .length,
        1,
      );
      assert.equal(
        (await credits.getAccount(creditScope))?.reservedCredits,
        "23",
      );
      const renewed = await create().createTaskFromPlugin(actor, command, {
        ...pin,
        authorityEpoch: "fixture-renewed-current-plugin-epoch",
      });
      assert.equal(renewed.run.disposition, "replayed");
      assert.deepEqual(renewed.binding, accepted.binding);
      assert.deepEqual(renewed.creditAdmission, accepted.creditAdmission);
      assert.deepEqual(
        await f.first.store.loadPluginTaskAdmission(accepted.binding),
        persisted,
      );
      assert.equal(quoteCalls, 1);
      await installs.commitSelection(
        selectionRecipe(enabled.selection, "installed-app-uninstall", {
          actor,
          state: "uninstalled",
        }),
      );
      const replay = await create().createTaskFromPlugin(actor, command, pin);
      assert.equal(replay.run.disposition, "replayed");
      assert.equal(quoteCalls, 1);
      assert.deepEqual(replay.binding, accepted.binding);
      assert.deepEqual(replay.creditAdmission, accepted.creditAdmission);
      assert.equal(await f.count("plugin_task_admissions"), 1);
      assert.equal(await f.count("run_snapshots"), 1);
      assert.equal(
        (await credits.getAccount(creditScope))?.reservedCredits,
        "23",
      );
      await assert.rejects(
        create().createTaskFromPlugin(
          actor,
          { ...command, idempotencyKey: "another-new-request" },
          pin,
        ),
        (e) =>
          e instanceof ApplicationError &&
          e.code === "extension_credit_quote_unavailable",
      );
      assert.equal(await f.count("run_snapshots"), 1);
    },
  );
