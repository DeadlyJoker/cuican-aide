import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  ExtensionTaskApplicationService,
  PluginUiApplicationService,
  PluginUiCommittedTaskAuthority,
  capturePluginUiInvocationCommitAuthority,
  projectGenerationUiTaskCommand,
} from "@crewon/application";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  createConceptAsset,
  parsePluginTaskAdmissionPin,
} from "@crewon/domain";
import {
  actor,
  activateCommand,
  configurationServiceFixture,
  saveCommand,
} from "./extension-configuration-service.test-support.ts";
import { scope, timestamp } from "./extension-store.test-support.ts";
import { seedThread } from "./thread-store-conformance.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";
import {
  creationRecipe,
  receipt,
} from "./creative-project-store.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { uiTestDescriptor } from "../../application/src/plugin-ui.test-support.ts";

/** Actual UI Application invocation and SQL paid task; external policy, package verifier and readiness are explicit doubles. */
for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend} actual published UI handler commits and acknowledges on a one-connection pool without a nested full UI fence`,
    {
      skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
      timeout: 15_000,
    },
    async (t) => {
      const f = await configurationServiceFixture(t, backend, {
        maxPoolSize: 1,
      });
      await f.seedDeployment();
      await f.service.saveConfiguration(actor, saveCommand);
      await f.service.setActivation(actor, activateCommand);
      const threadId = "published-project-app-thread";
      await seedThread(f.first.parent, { ...actor, threadId });
      const profile = {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        profileId: "published-app-profile",
      };
      const installs = f.first.parent.pluginInstallationStore();
      await installs.migrate();
      const execution = await installs.recordInstalledPackage(
        installationRecipe("published-execution", {
          scope: profile,
          actor,
          pluginId: scope.pluginId,
          version: saveCommand.pluginVersion,
        }),
      );
      const executionSelected = await installs.commitSelection(
        selectionRecipe(execution.selection, "published-execution-enable", {
          actor,
        }),
      );
      const business = await installs.recordInstalledPackage(
        installationRecipe("published-business", {
          scope: profile,
          actor,
          pluginId: "example.business-ui",
          version: "5.0.0",
        }),
      );
      const businessSelected = await installs.commitSelection(
        selectionRecipe(business.selection, "published-business-enable", {
          actor,
        }),
      );
      const executionPin = parsePluginTaskAdmissionPin({
        ...profile,
        ...actor,
        pluginId: execution.package.pluginId,
        publisherId: execution.package.publisherId,
        version: execution.package.version,
        packageDigest: execution.package.packageDigest,
        selectionRevision: executionSelected.selection.revision,
        contributionId: "workbench",
        action: "image.generate",
        authorityEpoch: "execution-policy-1",
      });
      const publication = {
        source: {
          pluginId: business.package.pluginId,
          packageDigest: business.package.packageDigest,
          contributionId: "workbench",
        },
        target: {
          pluginId: executionPin.pluginId,
          packageDigest: executionPin.packageDigest,
          contributionId: executionPin.contributionId,
          action: executionPin.action,
        },
      };
      const descriptor = parsePluginPackageDescriptor({
        ...uiTestDescriptor,
        pluginId: business.package.pluginId,
        publisherId: business.package.publisherId,
        version: business.package.version,
        entrypoints: {
          node: null,
          ui: { path: "ui.mjs", mode: "trustedModule" },
        },
        files: uiTestDescriptor.files.filter((file) => file.path === "ui.mjs"),
        requires: [
          {
            service: "crewon.project-generations",
            apiVersion: "1",
            optional: false,
          },
        ],
      });
      await f.first.store.migrateCredits();
      await f.first.store.migratePluginAdmissions();
      const creditScope = {
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        poolId: "published-app-fixture",
      };
      const credits = f.first.parent.pluginCreditStore();
      await credits.grant({
        scope: creditScope,
        grantId: "published-app-fixture-funding",
        credits: "100",
      });
      const projects = f.first.parent.creativeProjectStore();
      await projects.migrate();
      const initial = await projects.commitProjectCreation(
        creationRecipe(
          "published-project",
          "published-create",
          actor,
          timestamp,
        ),
      );
      const prompt = " exact saved prompt\n before dispatch ";
      const concept = createConceptAsset(
        {
          project: initial.project,
          actor,
          expectedProjectRevision: initial.project.revision,
          brief: initial.brief,
          assetId: "published-concept",
          name: "Concept",
          prompt,
          at: timestamp,
        },
        extensionStoreDigester,
      );
      const saved = await projects.commitConceptRevision({
        kind: "create-concept",
        actor,
        receipt: receipt("published-concept-create"),
        expectedProjectRevision: initial.project.revision,
        ...concept,
      });
      await f.first.store.migrateProjectGenerations();
      const reference = {
        projectId: saved.project.projectId,
        assetId: saved.asset.assetId,
        assetRevision: 1,
        expectedProjectRevision: saved.project.revision,
        expectedAssetMetadataRevision: saved.asset.revision,
      };
      let quoteCalls = 0,
        fullChecks = 0,
        transactionChecks = 0;
      const tasks = new ExtensionTaskApplicationService({
        ...f.dependencies,
        store: f.first.parent,
        extensions: f.first.store,
        operations: f.operations,
        ids: { nextId: () => randomUUID() },
        creativeProjects: {
          store: projects,
          authorization: {
            async authorize() {
              return { outcome: "allow" };
            },
          },
        },
        creditQuotes: {
          async quoteGeneration() {
            quoteCalls++;
            return {
              poolId: creditScope.poolId,
              priceRevision: 1,
              quotedCredits: "30",
            };
          },
        },
      });
      const committed = new PluginUiCommittedTaskAuthority({
        extensions: f.first.store,
        runs: f.first.parent,
        digester: extensionStoreDigester,
        projectGenerations: { publications: [publication], projects },
      });
      let sourceAlive = true,
        targetAlive = true;
      const ui = new PluginUiApplicationService({
        store: installs,
        profiles: {
          async resolve() {
            return profile;
          },
        },
        authorization: {
          async authorize() {
            return sourceAlive
              ? { outcome: "allow", authorityEpoch: "source-policy-1" }
              : { outcome: "deny", reasonCode: "source-closed" };
          },
        },
        packages: {
          async verify() {
            return { descriptor, publicAssets: ["ui.mjs"] };
          },
          async readAsset() {
            throw new Error("unused");
          },
        },
        clock: { now: () => "2026-10-02T03:00:00.000Z" },
        ids: { nextId: () => "u".repeat(40) },
        committedTasks: committed,
        actions: {
          async invoke(context) {
            const invocation =
              capturePluginUiInvocationCommitAuthority(context);
            const sourcePin = parsePluginTaskAdmissionPin({
              ...context.actor,
              ...context.scope,
              pluginId: context.package.pluginId,
              publisherId: context.package.publisherId,
              version: context.package.version,
              packageDigest: context.package.packageDigest,
              selectionRevision: context.selection.revision,
              contributionId: context.lease.contributionId,
              action: context.action,
              authorityEpoch: context.authorityEpoch,
            });
            const request = {
              reference,
              threadId,
              expectedThreadRevision: 1,
              idempotencyKey: "published-ui-user-intent",
            };
            const revision = (await projects.loadConceptRevision({
              owner: {
                tenantId: actor.tenantId,
                spaceId: actor.spaceId,
                principalId: actor.principalId,
              },
              projectId: reference.projectId,
              assetId: reference.assetId,
              assetRevision: reference.assetRevision,
            }))!;
            const command = projectGenerationUiTaskCommand(
              { sourcePin, executionPin, request, prompt: revision.prompt },
              extensionStoreDigester,
            );
            const active = () => {
              invocation.assertActive();
              if (!sourceAlive || !targetAlive)
                throw new Error("original_owner_closed");
            };
            const result = await tasks.createPublishedProjectTaskFromPlugin({
              actor: context.actor,
              command,
              reference,
              publication,
              sourcePin,
              executionPin,
              authority: {
                async assertCurrent() {
                  fullChecks++;
                  await invocation.assertCurrent();
                  const selected = await installs.loadSelection({
                    scope: profile,
                    pluginId: executionPin.pluginId,
                  });
                  const pkg = await installs.loadPackage({
                    scope: profile,
                    packageDigest: executionPin.packageDigest,
                  });
                  assert.equal(
                    selected?.revision,
                    executionPin.selectionRevision,
                  );
                  assert.equal(selected?.state, "enabled");
                  assert.equal(pkg?.pluginId, executionPin.pluginId);
                  active();
                },
                async assertTransactionCurrent() {
                  transactionChecks++;
                  active();
                },
                assertActive: active,
              },
            });
            const checks = [fullChecks, transactionChecks];
            // Actual mount withdrawal immediately after the real SQL commit cannot turn acceptance into a retry.
            sourceAlive = false;
            targetAlive = false;
            await ui.closeMount(actor, { mountRef: context.lease.mountRef });
            const outcome = await committed.issueProjectGeneration({
              context,
              command,
              executionPin,
              result,
            });
            assert.deepEqual([fullChecks, transactionChecks], checks);
            return outcome;
          },
        },
      });
      const lease = await ui.openMount(actor, {
        pluginId: business.package.pluginId,
        contributionId: "workbench",
        expectedSelectionRevision: businessSelected.selection.revision,
        expectedPackageDigest: business.package.packageDigest,
      });
      const output = await ui.invoke(actor, {
        mountRef: lease.mountRef,
        action: "crewon.project-generations.v1.generateConcept",
        input: {
          reference,
          threadId,
          expectedThreadRevision: 1,
          idempotencyKey: "published-ui-user-intent",
        },
      });
      assert.equal(
        (output as { disposition: string }).disposition,
        "committed",
      );
      assert.equal(fullChecks, 2);
      assert.ok(transactionChecks >= 2);
      assert.equal(quoteCalls, 1);
      for (const table of [
        "run_snapshots",
        "messages",
        "model_history_items",
        "creative_project_generation_links",
        "plugin_task_admissions",
        "plugin_credit_reservations",
      ])
        assert.equal(await f.count(table), 1, table);
      assert.equal(
        (await credits.getAccount(creditScope))?.reservedCredits,
        "30",
      );
    },
  );
