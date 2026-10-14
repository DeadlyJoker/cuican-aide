import assert from "node:assert/strict";
import test from "node:test";
import {
  qualifyProjectAssetRuntimeReadObservation,
  type ProjectAssetRuntimeReadObservation,
} from "@crewon/application/host-project-workspaces";
import { assetTestOptions } from "../../../packages/store/src/project-asset.test-support.ts";
import { assetToolsFixture } from "./project-asset-tools-service-owner.test-support.ts";
import { markAssetToolsOwnedProject } from "./project-asset-owned.test-support.ts";
import { InstalledPluginRunContext } from "./plugins/installed-plugin-run-context.ts";

for (const backend of ["sqlite", "postgres"] as const) {
  for (const variant of [
    "matching",
    "foreign",
    "missing",
    "workspace",
  ] as const) {
    test(
      `${backend}: real installed asset startup validates original receipt and protected namespace (${variant})`,
      assetTestOptions(backend),
      async (t) => {
        const f = await assetToolsFixture(t, backend);
        await markAssetToolsOwnedProject(f, variant);
        const admission = f.admission,
          binding = f.binding;
        const receipt = {
          actorId: admission.actorId,
          idempotencyKey: admission.idempotencyKey,
          requestDigest: admission.requestDigest,
        };
        await assert.rejects(
          f.first.store.loadExtensionTurnReceipt({ ...binding, receipt }),
        );
        let token: ProjectAssetRuntimeReadObservation | undefined;
        const extensions = new Proxy(f.first.store, {
          get(target, key) {
            if (key === "loadExtensionTurnReceipt")
              return async (
                ...args: Parameters<typeof target.loadExtensionTurnReceipt>
              ) => {
                token =
                  args[1] && "projectAssetRuntimeReadObservation" in args[1]
                    ? args[1].projectAssetRuntimeReadObservation
                    : undefined;
                if (token !== undefined) {
                  assert.deepEqual(
                    qualifyProjectAssetRuntimeReadObservation(token).admission,
                    admission,
                  );
                  await assert.rejects(
                    target.loadExtensionTurnReceipt(args[0], {
                      projectAssetRuntimeReadObservation: { ...token },
                    }),
                  );
                }
                return target.loadExtensionTurnReceipt(args[0], args[1]);
              };
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const reader = new InstalledPluginRunContext({
          extensions,
          runs: f.parent,
          installations: f.installs,
          assetStages: f.stages,
          projectOwnership: "plugin-project-v1",
          authorization: {
            authorize: async () =>
              f.state.policy
                ? { outcome: "allow" }
                : {
                    outcome: "deny",
                    reasonCode: "named_asset_runtime_pdp_denied",
                  },
          },
          resolveActor: async () => f.controls.actor,
        });
        const load = () =>
          reader.load({
            locator: {
              tenantId: binding.tenantId,
              spaceId: binding.spaceId,
              runId: binding.runId,
            },
            expectedTarget: binding.target,
            purpose: "submit",
            signal: new AbortController().signal,
          });
        if (variant !== "matching") {
          await assert.rejects(load());
          return;
        }
        f.state.policy = false;
        await assert.rejects(load(), /execution_access_denied/);
        assert.equal(token, undefined);
        f.state.policy = true;
        const before = await f.counts();
        const snapshot = await load();
        assert.ok(snapshot);
        assert.deepEqual(
          reader.verifiedProjectAssetStage(snapshot),
          f.admitted!.assetStageAdmission,
        );
        assert.ok(token);
        assert.throws(
          () => qualifyProjectAssetRuntimeReadObservation(token!),
          /lifetime_ended/,
        );
        assert.throws(
          () => qualifyProjectAssetRuntimeReadObservation({ ...token! }),
          /observation_invalid/,
        );
        await reader.assertCurrent(
          snapshot,
          "submit",
          new AbortController().signal,
        );
        const activation = await f.first.store.loadExtensionActivation(binding);
        assert.ok(activation);
        await f.first.store.saveExtensionActivation({
          activation: {
            ...activation,
            revision: activation.revision + 1,
            state: "revoked",
            updatedAt: new Date().toISOString(),
          },
          expectedRevision: activation.revision,
          receipt: {
            actorId: f.actor.actorId,
            idempotencyKey: "asset-runtime-revoke",
            requestDigest: f.digester.sha256("asset-runtime-revoke"),
          },
        });
        await assert.rejects(
          reader.assertCurrent(
            snapshot,
            "submit",
            new AbortController().signal,
          ),
        );
        assert.deepEqual(await f.counts(), before);
      },
    );
  }
}
