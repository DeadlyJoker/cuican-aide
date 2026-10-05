import {
  CREWON_CREATIVE_PROJECTS_SERVICE,
  CREWON_CREATIVE_PROJECTS_API_VERSION,
  parsePluginPackageDescriptor,
  type PluginPackageDescriptor,
} from "@crewon/contracts/plugins";
import { PluginUiApplicationService } from "./plugin-ui-application-service.ts";
import { PluginCreativeProjectActionOwner } from "./plugin-creative-project-action-owner.ts";
import type {
  PluginUiActionContext,
  PluginUiActionPort,
} from "./plugin-ui-ports.ts";
import {
  parseInstalledPluginPackage,
  parsePluginSelection,
} from "@crewon/domain";
import { createFixture } from "./creative-project.test-support.ts";
import {
  uiFixture,
  uiTestActor,
  uiTestBytes,
  uiTestDescriptor,
  uiTestDigest,
  uiTestMountCommand,
} from "./plugin-ui.test-support.ts";

/** Real Application/PluginUI services over explicit memory fixtures; not a SQL or producer proof. */
export function creativeActionFixture(
  options: Readonly<{
    descriptor?: PluginPackageDescriptor;
    packageDigest?: string;
  }> = {},
) {
  const projects = createFixture();
  const ui = uiFixture();
  ui.state.descriptor = options.descriptor ?? creativeActionDescriptor();
  const descriptor = ui.state.descriptor;
  const packageDigest = options.packageDigest ?? uiTestDigest;
  ui.state.package = parseInstalledPluginPackage({
    ...ui.state.package,
    pluginId: descriptor.pluginId,
    publisherId: descriptor.publisherId,
    version: descriptor.version,
    packageDigest,
  });
  ui.state.selection = parsePluginSelection({
    ...ui.state.selection,
    pluginId: descriptor.pluginId,
    publisherId: descriptor.publisherId,
    selectedPackageDigest: packageDigest,
  });
  const state = {
    hostAllowed: true,
    hostCalls: 0,
    hostContexts: [] as PluginUiActionContext[],
    beforeHost: null as (() => Promise<void>) | null,
    afterAction: null as
      | ((
          context: PluginUiActionContext,
          output: Awaited<ReturnType<PluginUiActionPort["invoke"]>>,
        ) => Promise<void> | void)
      | null,
    rawOverride: undefined as
      | Awaited<ReturnType<PluginUiActionPort["invoke"]>>
      | undefined,
    context: null as PluginUiActionContext | null,
    raw: undefined as
      | Awaited<ReturnType<PluginUiActionPort["invoke"]>>
      | undefined,
  };
  const publications = [
    {
      pluginId: descriptor.pluginId,
      packageDigest,
      contributionId: "workbench",
    },
  ];
  const owner = new PluginCreativeProjectActionOwner({
    projects: projects.service,
    publications,
    authorization: {
      async authorize(context) {
        state.hostCalls++;
        state.hostContexts.push(context);
        await state.beforeHost?.();
        if (!state.hostAllowed) throw new Error("fixture_module_unavailable");
      },
    },
  });
  const service = new PluginUiApplicationService({
    store: ui.store,
    profiles: {
      async resolve() {
        return ui.state.scope;
      },
    },
    authorization: {
      async authorize(input) {
        await ui.state.beforeAuthorize?.(input.action);
        return ui.state.allowed.has(input.action)
          ? { outcome: "allow", authorityEpoch: ui.state.epoch }
          : { outcome: "deny", reasonCode: "denied" };
      },
    },
    packages: {
      async verify() {
        return { descriptor: ui.state.descriptor, publicAssets: ["ui.mjs"] };
      },
      async readAsset() {
        return {
          bytes: uiTestBytes,
          contentType: "text/javascript; charset=utf-8",
        };
      },
    },
    ids: { nextId: () => "m".repeat(40) },
    clock: { now: () => ui.state.now },
    committedMetadata: owner.committedMetadata,
    actions: {
      async invoke(context) {
        state.context = context;
        const raw =
          state.rawOverride === undefined
            ? await owner.actions.invoke(context)
            : state.rawOverride;
        state.raw = raw;
        await state.afterAction?.(context, raw);
        return raw;
      },
    },
  });
  const open = () =>
    service.openMount(uiTestActor, {
      ...uiTestMountCommand,
      pluginId: descriptor.pluginId,
      expectedPackageDigest: packageDigest,
    });
  const invoke = async (method: string, input: unknown) => {
    const lease = await open();
    return service.invoke(uiTestActor, {
      mountRef: lease.mountRef,
      action: `crewon.creative-projects.v1.${method}`,
      input: input as never,
    });
  };
  return { owner, projects, ui, state, service, publications, open, invoke };
}

export function creativeActionDescriptor(
  overrides: Partial<PluginPackageDescriptor> = {},
): PluginPackageDescriptor {
  return parsePluginPackageDescriptor({
    ...uiTestDescriptor,
    requires: [
      {
        service: CREWON_CREATIVE_PROJECTS_SERVICE,
        apiVersion: CREWON_CREATIVE_PROJECTS_API_VERSION,
        optional: false,
      },
    ],
    ...overrides,
  });
}

export function creativeCreateInput(key = "create-metadata-1") {
  return {
    request: { title: "雨夜相逢", briefText: "两个人在雨夜重逢。" },
    idempotencyKey: key,
  };
}
