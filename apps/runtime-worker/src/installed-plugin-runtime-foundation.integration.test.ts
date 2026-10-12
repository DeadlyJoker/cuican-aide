import { selectionRecipe } from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { qualifyPluginProjectRuntimeObservation } from "@crewon/application/host-project-workspaces";
import { InstalledPluginRunContext } from "./plugins/installed-plugin-run-context.ts";
import { foundationToolsOwnerFixture } from "./plugins/project-foundation-tools-service-owner.test-support.ts";
import { foundationMetadataFixture } from "../../../packages/store/src/project-foundation-legacy-access.test-support.ts";

for (const backend of ["sqlite", "postgres"] as const)
  for (const origin of ["creative", "novel"] as const)
    test(
      `${backend}/${origin}: original runtime initializes protected Foundation metadata after PDP and closes the borrowed capability`,
      { skip: backend === "postgres" && !process.env.CREWON_TEST_POSTGRES_URL },
      async (t) => {
        const f = await foundationToolsOwnerFixture(t, origin, backend);
        const m = await foundationMetadataFixture(t, {
          backend,
          path: f.databasePath,
          schema: f.schema ?? "main",
          prefix: f.prefix,
        });
        await m.migrate();
        const owner = {
          ...f.actor,
          profileId: f.taskAdmission.profileId,
          pluginId: f.taskAdmission.pluginId,
          publisherId: f.taskAdmission.publisherId,
        };
        await m.mark(f.admission.projectId, owner);
        let reads = 0,
          revoked = false,
          token:
            | Parameters<typeof qualifyPluginProjectRuntimeObservation>[0]
            | undefined;
        const dependencies = {
          extensions: f.first.store,
          runs: f.parent,
          installations: f.installs,
          authorization: {
            authorize: async () =>
              f.state.policy
                ? { outcome: "allow" as const }
                : {
                    outcome: "deny" as const,
                    reasonCode: "named-runtime-policy-denied",
                  },
          },
          resolveActor: f.dependencies.resolveActor,
          conversations: f.parent.projectConversationStore(),
          foundationRuns: {
            readRequiredFoundationDigest:
              f.foundationRuns.readRequiredFoundationDigest.bind(
                f.foundationRuns,
              ),
            loadFoundationRunAdmission:
              f.foundationRuns.loadFoundationRunAdmission.bind(
                f.foundationRuns,
              ),
            async loadRuntimeFoundationRunAdmission(
              ref: Parameters<typeof qualifyPluginProjectRuntimeObservation>[0],
            ) {
              reads++;
              token = ref;
              assert.equal(
                qualifyPluginProjectRuntimeObservation(ref).stage.projectId,
                f.admission.projectId,
              );
              const result =
                await f.foundationRuns.loadRuntimeFoundationRunAdmission!(ref);
              if (revoked) f.state.policy = false;
              return result;
            },
          },
          projectOwnership: "plugin-project-v1" as const,
        };
        const load = (reader: InstalledPluginRunContext) =>
          reader.load({
            locator: {
              tenantId: f.binding.tenantId,
              spaceId: f.binding.spaceId,
              runId: f.binding.runId,
            },
            expectedTarget: f.binding.target,
            purpose: "submit",
            signal: new AbortController().signal,
          });
        const reader = new InstalledPluginRunContext(dependencies);
        const before = await f.counts();
        f.state.policy = false;
        await assert.rejects(load(reader), /execution_access_denied/u);
        assert.equal(reads, 0);
        f.state.policy = true;
        const snapshot = await load(reader);
        assert.ok(snapshot);
        assert.deepEqual(
          reader.verifiedProjectFoundation(snapshot),
          f.admission,
        );
        assert.ok(token);
        assert.throws(
          () => qualifyPluginProjectRuntimeObservation(token!),
          /lifetime_ended/u,
        );
        await reader.assertCurrent(
          snapshot,
          "submit",
          new AbortController().signal,
        );
        assert.ok(await load(new InstalledPluginRunContext(dependencies)));
        assert.equal(reads, 3);
        revoked = true;
        await assert.rejects(load(reader), /execution_access_denied/u);
        assert.throws(
          () => qualifyPluginProjectRuntimeObservation(token!),
          /lifetime_ended/u,
        );
        assert.deepEqual(await f.counts(), before);
        let getterCalls = 0;
        assert.throws(
          () =>
            new InstalledPluginRunContext({
              ...dependencies,
              get projectOwnership() {
                getterCalls++;
                return "plugin-project-v1" as const;
              },
            }),
          /ownership_invalid/u,
        );
        assert.equal(getterCalls, 0);
        revoked = false;
        f.state.policy = true;
        let selection = f.enabled.selection;
        for (const state of ["disabled", "uninstalled"] as const) {
          const result = await f.installs.commitSelection(
            selectionRecipe(selection, `runtime-foundation-${state}`, {
              actor: f.actor,
              state,
            }),
          );
          selection = result.selection;
          await assert.rejects(load(reader), /generation_disabled/u);
          const observed = await reader.load({
            locator: {
              tenantId: f.binding.tenantId,
              spaceId: f.binding.spaceId,
              runId: f.binding.runId,
            },
            expectedTarget: f.binding.target,
            purpose: "observe",
            signal: new AbortController().signal,
          });
          assert.ok(observed);
          assert.deepEqual(
            reader.verifiedProjectFoundation(observed),
            f.admission,
          );
        }
        for (const projectOwnership of [undefined, "unknown"])
          assert.throws(
            () =>
              new InstalledPluginRunContext({
                ...dependencies,
                projectOwnership,
              } as never),
            /ownership_invalid/u,
          );
      },
    );
