import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ExtensionTaskApplicationService } from "@crewon/application";
import {
  createConceptAsset,
  parsePluginTaskAdmissionPin,
  type ProjectGenerationReference,
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
import { activeAuthority } from "./project-generation.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const)
  test(
    `${backend} actual application generation commits and replays on a single-connection pool without nested project reads`,
    {
      skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL,
      timeout: 10_000,
    },
    async (t) => {
      const f = await configurationServiceFixture(t, backend, {
        maxPoolSize: 1,
      });
      await f.seedDeployment();
      await f.service.saveConfiguration(actor, saveCommand);
      await f.service.setActivation(actor, activateCommand);
      const threadId = "project-app-thread";
      await seedThread(f.first.parent, { ...actor, threadId });
      const profile = {
        tenantId: actor.tenantId,
        spaceId: actor.spaceId,
        profileId: "project-app-profile",
      };
      const installs = f.first.parent.pluginInstallationStore();
      await installs.migrate();
      const recipe = installationRecipe("project-app-install", {
        scope: profile,
        actor,
        pluginId: scope.pluginId,
        version: saveCommand.pluginVersion,
      });
      const installed = await installs.recordInstalledPackage(recipe);
      const enabled = await installs.commitSelection(
        selectionRecipe(installed.selection, "project-app-enable", { actor }),
      );
      await f.first.store.migrateCredits();
      await f.first.store.migratePluginAdmissions();
      const creditScope = {
        tenantId: actor.tenantId,
        principalId: actor.principalId,
        poolId: "project-app-fixture",
      };
      const credits = f.first.parent.pluginCreditStore();
      await credits.grant({
        scope: creditScope,
        grantId: "project-app-fixture-funding",
        credits: "100",
      });
      const projects = f.first.parent.creativeProjectStore();
      await projects.migrate();
      const initial = await projects.commitProjectCreation(
        creationRecipe(
          "project-app-source",
          "project-app-create",
          actor,
          timestamp,
        ),
      );
      const prompt = " 已保存的街角\n 保留空格 ";
      const concept = createConceptAsset(
        {
          project: initial.project,
          actor,
          expectedProjectRevision: initial.project.revision,
          brief: initial.brief,
          assetId: "project-app-concept",
          name: "街角",
          prompt,
          at: timestamp,
        },
        extensionStoreDigester,
      );
      const source = await projects.commitConceptRevision({
        kind: "create-concept",
        actor,
        receipt: receipt("project-app-concept"),
        expectedProjectRevision: initial.project.revision,
        ...concept,
      });
      await f.first.store.migrateProjectGenerations();
      const reference: ProjectGenerationReference = {
        projectId: source.project.projectId,
        assetId: source.asset.assetId,
        assetRevision: source.assetRevision.assetRevision,
        expectedProjectRevision: source.project.revision,
        expectedAssetMetadataRevision: source.asset.revision,
      };
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
        authorityEpoch: "project-app-epoch",
      });
      const command = {
        pluginId: scope.pluginId,
        threadId,
        expectedThreadRevision: 1,
        idempotencyKey: "project-app-generate",
        intent: { kind: "generate" as const, input: { prompt } },
      };
      let quoteCalls = 0;
      const permissions: string[] = [];
      const service = new ExtensionTaskApplicationService({
        ...f.dependencies,
        store: f.first.parent,
        extensions: f.first.store,
        operations: f.operations,
        ids: { nextId: () => randomUUID() },
        creativeProjects: {
          store: projects,
          authorization: {
            async authorize(input) {
              assert.deepEqual(input.actor, actor);
              permissions.push(input.action);
              return { outcome: "allow" };
            },
          },
        },
        creditQuotes: {
          async quoteGeneration(input) {
            assert.equal(input.actor.principalId, actor.principalId);
            quoteCalls++;
            return {
              poolId: creditScope.poolId,
              priceRevision: 1,
              quotedCredits: "30",
            };
          },
        },
      });
      const accepted = await service.createProjectTaskFromPlugin(
        actor,
        command,
        pin,
        reference,
        activeAuthority.projectGenerationAuthority,
      );
      assert.equal(accepted.run.disposition, "committed");
      assert.equal(quoteCalls, 1);
      assert.ok(permissions.includes("creativeProject:write"));
      const link = await f.first.store.loadProjectGenerationLink(
        accepted.binding,
      );
      assert.ok(link);
      assert.equal(link.ownerPrincipalId, actor.principalId);
      assert.equal(link.assetContentDigest, source.assetRevision.contentDigest);
      assert.deepEqual(link.reference, reference);
      assert.equal(
        (await credits.getAccount(creditScope))?.reservedCredits,
        "30",
      );
      const replay = await service.createProjectTaskFromPlugin(
        actor,
        command,
        pin,
        reference,
        activeAuthority.projectGenerationAuthority,
      );
      assert.equal(replay.run.disposition, "replayed");
      assert.deepEqual(replay.binding, accepted.binding);
      assert.equal(quoteCalls, 1);
      for (const table of [
        "run_snapshots",
        "messages",
        "creative_project_generation_links",
        "plugin_credit_reservations",
      ])
        assert.equal(await f.count(table), 1, table);
    },
  );
