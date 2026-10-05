import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  PROJECT_TEXT_UI_METHOD_ACTIONS,
  type ProjectTextUiMethod,
} from "@crewon/contracts/project-texts-ui";
import { PluginUiApplicationService } from "./plugin-ui-application-service.ts";
import { PluginProjectTextActionOwner } from "./plugin-project-text-action-owner.ts";
import { ProjectTextApplicationService } from "./project-text-application-service.ts";
import {
  createCommand,
  createFixture,
  sha256,
} from "./creative-project.test-support.ts";
import { MemoryProjectText } from "./project-text.test-support.ts";
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

/** Genuine Application and UI invocation lifecycle over explicit memory ports; no SQL/Native policy is claimed. */
export async function projectTextActionFixture() {
  const ui = uiFixture();
  ui.state.descriptor = parsePluginPackageDescriptor({
    ...uiTestDescriptor,
    entrypoints: { ...uiTestDescriptor.entrypoints, node: null },
    requires: [
      { service: "crewon.project-texts", apiVersion: "1", optional: false },
    ],
  });
  const projects = createFixture();
  const created = await projects.service.createProject(
    uiTestActor,
    createCommand(),
  );
  const store = new MemoryProjectText(projects.store);
  const state = {
    projectAllowed: true,
    hostAllowed: true,
    ids: 0,
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
  const texts = new ProjectTextApplicationService({
    store,
    projects: projects.store,
    authorization: {
      authorize: async () =>
        state.projectAllowed
          ? { outcome: "allow" }
          : { outcome: "deny", reasonCode: "fixture_project_denied" },
    },
    clock: {
      now: () => new Date(Date.UTC(2026, 9, 5, 0, 0, state.ids)).toISOString(),
    },
    ids: { nextId: () => `text-${++state.ids}` },
    digester: { sha256 },
  });
  const publications = [
    {
      pluginId: uiTestDescriptor.pluginId,
      packageDigest: uiTestDigest,
      contributionId: "workbench",
    },
  ];
  const owner = new PluginProjectTextActionOwner({
    texts,
    publications,
    authorization: {
      authorize: async () => {
        await state.beforeHost?.();
        if (!state.hostAllowed)
          throw new Error("fixture_text_publication_withdrawn");
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
  const invoke = (method: ProjectTextUiMethod, input: unknown) =>
    service.invoke(uiTestActor, {
      mountRef: lease.mountRef,
      action: PROJECT_TEXT_UI_METHOD_ACTIONS[method],
      input: input as never,
    });
  return {
    ui,
    projects,
    project: created.project,
    store,
    texts,
    state,
    publications,
    owner,
    service,
    lease,
    invoke,
  };
}
