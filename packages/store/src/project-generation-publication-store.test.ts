import assert from "node:assert/strict";
import test from "node:test";
import {
  appendConceptAssetRevision,
  setCreativeProjectState,
} from "@crewon/domain";
import { publicationFixture } from "./project-generation-publication.test-support.ts";
import {
  generationTables,
  observeGenerationWrite,
} from "./project-generation.test-support.ts";
import { extensionStoreDigester } from "./extension-store-records.ts";
import { receipt } from "./creative-project-store.test-support.ts";
import {
  installationRecipe,
  selectionRecipe,
} from "./plugin-installation-store.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  const pg = backend === "postgres";
  const settings = {
    skip: pg && !process.env.CREWON_TEST_POSTGRES_URL,
    timeout: 15_000,
  };
  test(
    `${backend} published generation commits one target admission, original receipt, immutable link and personal hold`,
    settings,
    async (t) => {
      const f = await publicationFixture(t, backend);
      assert.equal(
        f.first.store.projectGenerationPublicationVersion,
        "crewon.project-generation-publication.v1",
      );
      assert.notEqual(f.sourcePin.pluginId, f.executionPin.pluginId);
      const saved = await f.commit();
      assert.equal(saved.run.disposition, "committed");
      const admission = await f.first.store.loadPluginTaskAdmission(
        saved.binding,
      );
      assert.equal(admission?.pluginId, f.executionPin.pluginId);
      const link = await f.first.store.loadProjectGenerationLink(saved.binding);
      assert.equal(link?.binding.pluginId, f.executionPin.pluginId);
      assert.equal(
        link?.receipt.requestDigest,
        f.inputValue.receipt.requestDigest,
      );
      assert.equal("sourcePin" in saved, false);
      assert.equal("sourcePin" in link!, false);
      assert.equal(
        (await f.credits.getAccount(f.creditScope))?.reservedCredits,
        "30",
      );
      for (const table of generationTables)
        assert.ok((await f.count(table)) >= 1, table);
      assert.equal(await f.count("plugin_task_admissions"), 1);
    },
  );
  test(
    `${backend} published receipt replay does not reread live installation or current metadata CAS after uninstall and history advance`,
    settings,
    async (t) => {
      const f = await publicationFixture(t, backend);
      const saved = await f.commit();
      const owner = {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        principalId: f.actor.principalId,
      };
      const project = (await f.metadata.loadProject({
        owner,
        projectId: f.reference.projectId,
      }))!;
      const asset = (await f.metadata.loadConceptAsset({
        owner,
        projectId: project.projectId,
        assetId: f.reference.assetId,
      }))!;
      const brief = (await f.metadata.loadBrief({
        owner,
        projectId: project.projectId,
        briefRevision: 1,
      }))!;
      const next = appendConceptAssetRevision(
        {
          actor: f.actor,
          project,
          asset,
          brief,
          expectedProjectRevision: project.revision,
          expectedAssetMetadataRevision: asset.revision,
          prompt: "a later immutable input",
          at: project.updatedAt,
        },
        extensionStoreDigester,
      );
      await f.metadata.commitConceptRevision({
        kind: "append-concept",
        actor: f.actor,
        receipt: receipt("publication-next-concept"),
        expectedProjectRevision: project.revision,
        expectedAssetMetadataRevision: asset.revision,
        ...next,
      });
      const archived = setCreativeProjectState({
        project: next.project,
        actor: f.actor,
        expectedProjectRevision: next.project.revision,
        state: "archived",
        at: next.project.updatedAt,
      });
      await f.metadata.commitProjectMetadata({
        kind: "set-project-state",
        actor: f.actor,
        receipt: receipt("publication-archive"),
        expectedProjectRevision: next.project.revision,
        project: archived,
      });
      await f.selection("source", "uninstalled");
      await f.selection("target", "uninstalled");
      const before = await f.counts();
      const replay = await f.commit();
      assert.equal(replay.run.disposition, "replayed");
      assert.deepEqual(replay.binding, saved.binding);
      assert.deepEqual(await f.counts(), before);
      assert.equal(
        (await f.credits.getAccount(f.creditScope))?.reservedCredits,
        "30",
      );
    },
  );
  test(
    `${backend} either source or target disabled/uninstalled selection rejects fresh generation atomically`,
    settings,
    async (t) => {
      for (const owner of ["source", "target"] as const)
        for (const state of ["disabled", "uninstalled"] as const) {
          const f = await publicationFixture(t, backend);
          await f.selection(owner, state);
          const before = await f.counts();
          await assert.rejects(f.commit(), /plugin_task_admission_conflict/u);
          assert.deepEqual(await f.counts(), before);
          assert.equal(
            (await f.credits.getAccount(f.creditScope))?.reservedCredits,
            "0",
          );
        }
    },
  );
  test(
    `${backend} replacing either selected package rejects the stale captured exact installation`,
    settings,
    async (t) => {
      for (const owner of ["source", "target"] as const) {
        const f = await publicationFixture(t, backend);
        const current =
          owner === "source" ? f.source.selection : f.enabled.selection;
        const recipe = installationRecipe(`${owner}-replacement-package`, {
          scope: {
            tenantId: current.tenantId,
            spaceId: current.spaceId,
            profileId: current.profileId,
          },
          actor: f.actor,
          pluginId: current.pluginId,
          version: "9.0.0",
          expectedSelectionRevision: current.revision,
        });
        const installed = await f.installs.recordInstalledPackage(recipe);
        await f.installs.commitSelection(
          selectionRecipe(installed.selection, `${owner}-replacement-enable`, {
            actor: f.actor,
          }),
        );
        const before = await f.counts();
        await assert.rejects(f.commit(), /plugin_task_admission_conflict/u);
        assert.deepEqual(await f.counts(), before);
        assert.equal(
          (await f.credits.getAccount(f.creditScope))?.reservedCredits,
          "0",
        );
      }
    },
  );
  test(
    `${backend} publication execution qualification must exactly equal the real paid plugin admission`,
    settings,
    async (t) => {
      const f = await publicationFixture(t, backend);
      const before = await f.counts();
      const grant = f.commitOptions.projectGenerationPublication;
      for (const patch of [
        { selectionRevision: 99 },
        { authorityEpoch: "other-policy" },
        { publisherId: "other.publisher" },
        { version: "9.0.0" },
      ])
        await assert.rejects(
          f.first.store.commitExtensionTurn(f.inputValue, {
            ...f.commitOptions,
            projectGenerationPublication: {
              ...grant,
              executionPin: { ...grant.executionPin, ...patch },
            },
          }),
          /project_generation_execution_admission_mismatch/u,
        );
      assert.deepEqual(await f.counts(), before);
    },
  );
  test(
    `${backend} callback and publication option getters cannot replace the detached two-owner qualification`,
    settings,
    async (t) => {
      const f = await publicationFixture(t, backend);
      let reads = 0;
      const before = await f.counts();
      const getter = Object.defineProperty(
        { ...f.commitOptions },
        "projectGenerationPublication",
        {
          enumerable: true,
          get() {
            reads++;
            throw new Error("must-not-read");
          },
        },
      );
      await assert.rejects(
        f.first.store.commitExtensionTurn(f.inputValue, getter),
        /project_generation_publication_invalid/u,
      );
      await assert.rejects(
        f.first.store.commitExtensionTurn(f.inputValue, {
          ...f.commitOptions,
          principalId: "injected",
        } as typeof f.commitOptions),
        /project_generation_authority_required/u,
      );
      const detached = {
        publication: structuredClone(f.publication),
        sourcePin: { ...f.sourcePin },
        executionPin: { ...f.executionPin },
      };
      const authority = {
        async assertCurrent() {
          detached.sourcePin.packageDigest =
            extensionStoreDigester.sha256("late-replacement");
          authority.assertCurrent = () => {
            throw new Error("must-not-read-replacement");
          };
        },
        assertActive() {},
      };
      const saved = await f.first.store.commitExtensionTurn(f.inputValue, {
        projectGenerationPublication: detached,
        projectGenerationAuthority: authority,
      });
      assert.equal(saved.run.disposition, "committed");
      assert.equal(reads, 0);
      assert.equal(
        (await f.credits.getAccount(f.creditScope))?.reservedCredits,
        "30",
      );
      assert.equal(before.messages, 0);
      assert.equal(await f.count("messages"), 1);
    },
  );
  test(
    `${backend} captured original owner withdrawal after link insertion rolls the entire paid Turn back`,
    settings,
    async (t) => {
      for (const owner of ["source", "target"] as const) {
        const f = await publicationFixture(t, backend);
        let sourceAlive = true,
          targetAlive = true;
        const before = await f.counts();
        const restore = observeGenerationWrite(backend, () => {
          if (owner === "source") sourceAlive = false;
          else targetAlive = false;
        });
        t.after(restore);
        const assertActive = () => {
          if (!sourceAlive || !targetAlive)
            throw new Error("original_owner_closed");
        };
        await assert.rejects(
          f.first.store.commitExtensionTurn(f.inputValue, {
            ...f.commitOptions,
            projectGenerationAuthority: {
              async assertCurrent() {},
              assertActive,
            },
          }),
          /original_owner_closed/u,
        );
        restore();
        assert.deepEqual(await f.counts(), before);
        assert.equal(
          (await f.credits.getAccount(f.creditScope))?.reservedCredits,
          "0",
        );
      }
    },
  );
  test(
    `${backend} late transaction policy withdrawal rolls back prior link, history, Run and reservation writes`,
    settings,
    async (t) => {
      const f = await publicationFixture(t, backend);
      let alive = true;
      const before = await f.counts();
      const restore = observeGenerationWrite(backend, () => {
        alive = false;
      });
      t.after(restore);
      await assert.rejects(
        f.first.store.commitExtensionTurn(f.inputValue, {
          ...f.commitOptions,
          projectGenerationAuthority: {
            async assertCurrent() {
              if (!alive) throw new Error("late_policy_withdrawn");
            },
            assertActive() {
              if (!alive) throw new Error("late_policy_withdrawn");
            },
          },
        }),
        /late_policy_withdrawn/u,
      );
      restore();
      assert.deepEqual(await f.counts(), before);
    },
  );
  test(
    `${backend} publication requires explicit generation opt-in and cannot be supplied to an ordinary Turn`,
    settings,
    async (t) => {
      const f = await publicationFixture(t, backend, {
        generationMigration: false,
        metadata: false,
      });
      assert.equal(
        f.first.store.projectGenerationPublicationVersion,
        undefined,
      );
      const readAbsentMetadata = () =>
        f.metadata.loadProject({
          owner: {
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            principalId: f.actor.principalId,
          },
          projectId: f.reference.projectId,
        });
      await assert.rejects(readAbsentMetadata());
      await assert.rejects(f.commit(), /project_generation_unavailable/u);
      const { projectGeneration: _reference, ...plain } = f.inputValue;
      await assert.rejects(
        f.first.store.commitExtensionTurn(plain, f.commitOptions),
        /project_generation_reference_required/u,
      );
      await assert.rejects(readAbsentMetadata());
      assert.equal(
        (await f.credits.getAccount(f.creditScope))?.reservedCredits,
        "0",
      );
    },
  );
}
