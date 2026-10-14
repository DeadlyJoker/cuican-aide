import type { ProjectFoundationApplicationService } from "./project-foundation-application-service.ts";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  PROJECT_FOUNDATION_UI_METHOD_ACTIONS,
  type ProjectFoundationUiMethod,
} from "@crewon/contracts/project-foundation";
import { PluginUiApplicationService } from "./plugin-ui-application-service.ts";
import {
  PluginProjectFoundationActionOwner,
  type PluginProjectFoundationActionAuthorizationPort,
} from "./plugin-project-foundation-action-owner.ts";
import {
  createFixture,
  preparedSource,
} from "./project-foundation-application-test-support.ts";
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

/** Genuine UI mount/invoke over preinstalled enabled in-memory records and a genuine Foundation Service.
 * The explicitly trusted source recipes prove Application behavior, not durable ledger or SQL admission. */
export async function projectFoundationActionFixture(
  options: Readonly<{
    foundationService?: ProjectFoundationApplicationService;
    creationOwnership?: "plugin-project-v1";
    assertActive?: PluginProjectFoundationActionAuthorizationPort["assertActive"];
  }> = {},
) {
  const ui = uiFixture();
  ui.state.descriptor = parsePluginPackageDescriptor({
    ...uiTestDescriptor,
    entrypoints: { ...uiTestDescriptor.entrypoints, node: null },
    requires: [
      {
        service: "crewon.project-foundation",
        apiVersion: "1",
        optional: false,
      },
    ],
  });
  const foundations = createFixture({
    sourceAdmission: "trusted-internal-recipe",
  });
  for (const id of ["upload-1", "upload-2"])
    foundations.uploads.set(id, preparedSource(id, uiTestActor));
  const store = foundations.store;
  const state = {
    hostAllowed: true,
    context: null as PluginUiActionContext | null,
    raw: undefined as
      | Awaited<ReturnType<PluginUiActionPort["invoke"]>>
      | undefined,
    beforeHost: null as (() => Promise<void>) | null,
    onContext: null as ((context: PluginUiActionContext) => void) | null,
    afterAction: null as
      | ((
          context: PluginUiActionContext,
          raw: Awaited<ReturnType<PluginUiActionPort["invoke"]>>,
        ) => Promise<void> | void)
      | null,
  };
  const publications = [
    {
      pluginId: uiTestDescriptor.pluginId,
      packageDigest: uiTestDigest,
      contributionId: "workbench",
    },
  ];
  const owner = new PluginProjectFoundationActionOwner({
    foundations: options.foundationService ?? foundations.service,
    ...(options.creationOwnership === undefined
      ? {}
      : { creationOwnership: options.creationOwnership }),
    publications,
    authorization: {
      ...(options.assertActive === undefined
        ? {}
        : { assertActive: options.assertActive }),
      authorize: async () => {
        await state.beforeHost?.();
        if (!state.hostAllowed)
          throw new Error("fixture_foundation_publication_withdrawn");
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
          : { outcome: "deny", reasonCode: "fixture_denied" };
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
    actions: {
      invoke: async (context) => {
        state.context = context;
        state.onContext?.(context);
        const raw = await owner.actions.invoke(context);
        state.raw = raw;
        await state.afterAction?.(context, raw);
        return raw;
      },
    },
  });
  const lease = await service.openMount(uiTestActor, uiTestMountCommand);
  const invoke = (method: ProjectFoundationUiMethod, input: unknown) =>
    service.invoke(uiTestActor, {
      mountRef: lease.mountRef,
      action: PROJECT_FOUNDATION_UI_METHOD_ACTIONS[method],
      input: input as never,
    });
  return {
    ui,
    foundations,
    store,
    foundationService: foundations.service,
    state,
    publications,
    owner,
    service,
    lease,
    invoke,
  };
}
