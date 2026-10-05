import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  PROJECT_ASSET_UI_METHOD_ACTIONS,
  type ProjectAssetUiMethod,
} from "@crewon/contracts/project-assets";
import { PROJECT_ASSET_RECOVERY_METHOD_ACTIONS } from "@crewon/contracts/project-asset-recovery";
import {
  projectAssetFixture,
  assetAt,
} from "../../store/src/project-asset.test-support.ts";
import { PluginUiApplicationService } from "./plugin-ui-application-service.ts";
import { PluginProjectAssetActionOwner } from "./plugin-project-asset-action-owner.ts";
import { PluginProjectAssetRecoveryApplicationService } from "./plugin-project-asset-recovery-application-service.ts";
import { PluginProjectAssetRecoveryActionOwner } from "./plugin-project-asset-recovery-action-owner.ts";
import type {
  PluginUiActionContext,
  PluginUiCommittedMetadataOutcome,
} from "./plugin-ui-ports.ts";
import { uiTestDescriptor, uiTestBytes } from "./plugin-ui.test-support.ts";

/** Real dual database archives and genuine UI registration; package verification/PDP are named test ports. */
export async function projectAssetActionFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await projectAssetFixture(t, backend),
    actor = f.actor,
    install = f.installation,
    scope = {
      tenantId: install.tenantId,
      spaceId: install.spaceId,
      profileId: install.profileId,
    };
  const descriptor = parsePluginPackageDescriptor({
    ...uiTestDescriptor,
    pluginId: install.pluginId,
    version: install.version,
    publisherId: install.publisherId,
    entrypoints: { node: null, ui: uiTestDescriptor.entrypoints.ui },
    requires: ["crewon.project-assets", "crewon.project-asset-recovery"].map(
      (service) => ({ service, apiVersion: "1", optional: false }),
    ),
  });
  const publications = [
    {
      pluginId: install.pluginId,
      packageDigest: install.packageDigest,
      contributionId: "workbench",
    },
  ];
  const state = {
    allowed: true,
    epoch: "asset-ui-epoch",
    dropReply: false,
    onContext: null as ((context: PluginUiActionContext) => void) | null,
    beforeHost: null as (() => Promise<void>) | null,
    afterResult: null as (() => void) | null,
    context: null as PluginUiActionContext | null,
  };
  const recovery = new PluginProjectAssetRecoveryApplicationService({
    journal: f.journal,
    projects: f.parent.creativeProjectStore(),
    authorization: {
      authorize: async () =>
        f.policy.allow
          ? { outcome: "allow" as const }
          : {
              outcome: "deny" as const,
              reasonCode: "named_asset_project_policy_denied",
            },
    },
    publications,
    clock: { now: () => assetAt },
    digester: f.digester,
  });
  const createOwners = async () => {
    const authorization = {
      authorize: async () => {
        await state.beforeHost?.();
        if (!state.allowed) throw new Error("named_asset_host_withdrawn");
      },
    };
    const owner = new PluginProjectAssetActionOwner({
        assets: f.assets,
        recovery,
        publications,
        authorization,
      }),
      recoveryOwner = new PluginProjectAssetRecoveryActionOwner({
        recovery,
        publications,
        authorization,
      });
    const service = new PluginUiApplicationService({
      store: f.parent.pluginInstallationStore(),
      profiles: { resolve: async () => scope },
      authorization: {
        authorize: async () =>
          state.allowed
            ? { outcome: "allow", authorityEpoch: state.epoch }
            : { outcome: "deny", reasonCode: "named_asset_fixture_deny" },
      },
      packages: {
        verify: async () => ({ descriptor, publicAssets: ["ui.mjs"] }),
        readAsset: async () => ({
          bytes: uiTestBytes,
          contentType: "text/javascript; charset=utf-8",
        }),
      },
      clock: { now: () => assetAt },
      ids: { nextId: () => randomBytes(32).toString("base64url") },
      committedMetadata: {
        isOutcome: (
          value: unknown,
        ): value is PluginUiCommittedMetadataOutcome =>
          owner.committedMetadata.isOutcome(value) ||
          recoveryOwner.committedMetadata.isOutcome(value),
        verify: (context, outcome) =>
          owner.committedMetadata.isOutcome(outcome)
            ? owner.committedMetadata.verify(context, outcome)
            : recoveryOwner.committedMetadata.verify(context, outcome),
      },
      actions: {
        invoke: async (context) => {
          state.context = context;
          state.onContext?.(context);
          const result = await (
            owner.supportsAction(context.action)
              ? owner.actions
              : recoveryOwner.actions
          ).invoke(context);
          state.afterResult?.();
          if (state.dropReply)
            throw new Error("named_ack_lost_after_real_commit");
          return result;
        },
      },
    });
    const lease = await service.openMount(actor, {
      pluginId: install.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: install.selectionRevision,
      expectedPackageDigest: install.packageDigest,
    });
    const invoke = (method: ProjectAssetUiMethod, input: unknown) =>
      service.invoke(actor, {
        mountRef: lease.mountRef,
        action: PROJECT_ASSET_UI_METHOD_ACTIONS[method],
        input: input as never,
      });
    const recover = (method: "getPending" | "acknowledge", input: unknown) =>
      service.invoke(actor, {
        mountRef: lease.mountRef,
        action: PROJECT_ASSET_RECOVERY_METHOD_ACTIONS[method],
        input: input as never,
      });
    const close = async () => {
      await Promise.all([owner.close(), recoveryOwner.close()]);
    };
    t.after(close);
    return { owner, recoveryOwner, service, lease, invoke, recover, close };
  };
  return {
    ...f,
    uiScope: scope,
    state,
    recovery,
    createOwners,
    ...(await createOwners()),
  };
}
