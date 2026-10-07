import { randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import {
  PluginUiApplicationService,
  PluginProjectAssetV2ActionOwner,
  PluginProjectAssetActionOwner,
  type PluginUiActionContext,
} from "@crewon/application";
import {
  parseProjectAssetUiActionRequest,
  parseProjectAssetUiActionResponse,
} from "@crewon/contracts/project-assets";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  PROJECT_ASSET_V2_ACTIONS as actions,
  parseProjectAssetV2Request,
  parseProjectAssetV2Response,
} from "@crewon/contracts/project-assets-v2";
import {
  uiTestDescriptor,
  uiTestBytes,
} from "../../../packages/application/src/plugin-ui.test-support.ts";
import { mediaAdoptionServiceFixture } from "./project-asset-media-adoption-service.test-support.ts";

/** Genuine UI invocation and installed SQL identity; UI package verifier/PDP are named fixture ports. */
export async function assetV2UiFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await mediaAdoptionServiceFixture(t, backend),
    install = f.target.installation;
  const scope = {
    tenantId: install.tenantId,
    spaceId: install.spaceId,
    profileId: install.profileId,
  };
  const state = {
    allowed: true,
    dropReply: false,
    context: null as PluginUiActionContext | null,
    onContext: null as ((c: PluginUiActionContext) => void) | null,
    afterResult: null as (() => void) | null,
  };
  const createUi = async (
    options: {
      descriptorVersion?: string;
      publication?: "matching" | "foreign";
      ownerProtocol?: "v1" | "v2";
    } = {},
  ) => {
    const legacy = options.ownerProtocol === "v1";
    const apiVersion = options.descriptorVersion ?? (legacy ? "1" : "2");
    const descriptor = parsePluginPackageDescriptor({
      ...uiTestDescriptor,
      pluginId: install.pluginId,
      version: install.version,
      publisherId: install.publisherId,
      entrypoints: { node: null, ui: uiTestDescriptor.entrypoints.ui },
      requires: [
        { service: "crewon.project-assets", apiVersion, optional: false },
      ],
    });
    const dependencies = {
      publications: [
        {
          pluginId: install.pluginId,
          packageDigest:
            options.publication !== "foreign"
              ? install.packageDigest
              : "sha256:" + "a".repeat(64),
          contributionId: "workbench",
        },
      ],
      authorization: {
        authorize: async () => {
          if (!state.allowed) throw new Error("named_v2_host_denied");
        },
      },
    };
    const owner = legacy
      ? new PluginProjectAssetActionOwner({ ...dependencies, assets: f.assets })
      : new PluginProjectAssetV2ActionOwner({
          ...dependencies,
          assets: f.publicService,
        });
    const service = new PluginUiApplicationService({
      store: f.parent.pluginInstallationStore(),
      profiles: { resolve: async () => scope },
      authorization: {
        authorize: async () =>
          state.allowed
            ? { outcome: "allow", authorityEpoch: "asset-v2-epoch" }
            : { outcome: "deny", reasonCode: "named_v2_mount_denied" },
      },
      packages: {
        verify: async () => ({ descriptor, publicAssets: ["ui.mjs"] }),
        readAsset: async () => ({
          bytes: uiTestBytes,
          contentType: "text/javascript; charset=utf-8",
        }),
      },
      clock: { now: () => f.at },
      ids: { nextId: () => randomBytes(32).toString("base64url") },
      committedMetadata: owner.committedMetadata,
      actions: {
        invoke: async (context) => {
          state.context = context;
          state.onContext?.(context);
          const result = await owner.actions.invoke(context);
          state.afterResult?.();
          if (state.dropReply) throw new Error("named_v2_reply_lost");
          return result;
        },
      },
    });
    const lease = await service.openMount(f.actor, {
      pluginId: install.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: install.selectionRevision,
      expectedPackageDigest: install.packageDigest,
    });
    const invoke = async (method: keyof typeof actions, input: unknown) => {
      const request = parseProjectAssetV2Request({
        action: actions[method],
        input,
      });
      return parseProjectAssetV2Response(
        request,
        await service.invoke(f.actor, {
          mountRef: lease.mountRef,
          action: request.action,
          input: request.input as never,
        }),
      );
    };
    const invokeLegacy = async (
      method: keyof typeof actions,
      input: unknown,
    ) => {
      const request = parseProjectAssetUiActionRequest({
        action: actions[method].replace(".v2.", ".v1."),
        input,
      });
      return parseProjectAssetUiActionResponse(
        request,
        await service.invoke(f.actor, {
          mountRef: lease.mountRef,
          action: request.action,
          input: request.input as never,
        }),
      );
    };
    t.after(() => owner.close());
    return { owner, service, lease, invoke, invokeLegacy };
  };
  return { ...f, uiState: state, createUi, ...(await createUi()) };
}
