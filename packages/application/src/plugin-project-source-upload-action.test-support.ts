import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  PROJECT_SOURCE_UPLOAD_METHOD_ACTIONS as actions,
  type ProjectSourceUploadMethod,
} from "@crewon/contracts/project-source-uploads";
import { PluginUiApplicationService } from "./plugin-ui-application-service.ts";
import { PluginProjectSourceUploadActionOwner } from "./plugin-project-source-upload-action-owner.ts";
import { sourceUploadFixture } from "./project-source-upload.test-support.ts";
import type {
  PluginUiActionContext,
  PluginUiActionPort,
} from "./plugin-ui-ports.ts";
import {
  uiFixture,
  uiTestActor,
  uiTestBytes,
  uiTestDescriptor,
  uiTestDigest,
  uiTestMountCommand,
} from "./plugin-ui.test-support.ts";

/** Real UI open/invoke lifecycle and genuine Upload Service over explicitly trusted memory ports.
 * SQL installation qualification is covered independently by the dual-backend Store tests. */
export async function sourceUploadActionFixture(
  options: {
    publicationDigest?: string;
    raw?: boolean;
    authorizePart?: boolean;
  } = {},
) {
  const ui = uiFixture(),
    uploads = sourceUploadFixture();
  ui.state.descriptor = parsePluginPackageDescriptor({
    ...uiTestDescriptor,
    entrypoints: { ...uiTestDescriptor.entrypoints, node: null },
    requires: [
      {
        service: "crewon.project-source-uploads",
        apiVersion: "1",
        optional: false,
      },
    ],
  });
  const state = {
    hostAllowed: true,
    partAllowed: true,
    partContext: null as PluginUiActionContext | null,
    beforePart: null as (() => Promise<void>) | null,
    context: null as PluginUiActionContext | null,
    raw: undefined as
      | Awaited<ReturnType<PluginUiActionPort["invoke"]>>
      | undefined,
    afterAction: null as
      | ((
          context: PluginUiActionContext,
          raw: Awaited<ReturnType<PluginUiActionPort["invoke"]>>,
        ) => void | Promise<void>)
      | null,
  };
  const owner = new PluginProjectSourceUploadActionOwner({
    uploads: uploads.service,
    publications: [
      {
        pluginId: uiTestDescriptor.pluginId,
        packageDigest: options.publicationDigest ?? uiTestDigest,
        contributionId: "workbench",
      },
    ],
    authorization: {
      ...(options.raw && options.authorizePart !== false
        ? {
            authorizePart: async (context: PluginUiActionContext) => {
              state.partContext = context;
              await state.beforePart?.();
              if (!state.partAllowed)
                throw new Error("host_upload_part_denied");
            },
          }
        : {}),
      authorize: async () => {
        if (!state.hostAllowed) throw new Error("host_upload_denied");
      },
    },
  });
  const service = new PluginUiApplicationService({
    store: ui.store,
    profiles: { resolve: async () => ui.state.scope },
    authorization: {
      authorize: async (input) => {
        await ui.state.beforeAuthorize?.(input.action);
        return ui.state.allowed.has(input.action)
          ? { outcome: "allow", authorityEpoch: ui.state.epoch }
          : { outcome: "deny", reasonCode: "denied" };
      },
    },
    packages: {
      verify: async () => ({
        descriptor: ui.state.descriptor,
        publicAssets: ["ui.mjs"],
      }),
      readAsset: async () => ({
        bytes: uiTestBytes,
        contentType: "text/javascript; charset=utf-8",
      }),
    },
    ids: { nextId: () => "m".repeat(40) },
    clock: { now: () => ui.state.now },
    committedMetadata: owner.committedMetadata,
    ...(options.raw ? { sourceUploads: owner } : {}),
    actions: {
      invoke: async (context) => {
        state.context = context;
        const raw = await owner.actions.invoke(context);
        state.raw = raw;
        await state.afterAction?.(context, raw);
        return raw;
      },
    },
  });
  const lease = await service.openMount(uiTestActor, uiTestMountCommand);
  const invoke = (method: ProjectSourceUploadMethod, input: unknown) =>
    service.invoke(uiTestActor, {
      mountRef: lease.mountRef,
      action: actions[method],
      input: input as never,
    });
  return { ui, uploads, state, owner, service, lease, invoke };
}
