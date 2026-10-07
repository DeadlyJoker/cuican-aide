import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  PluginUiApplicationService,
  type PluginUiActionContext,
  type PluginUiCommittedTaskOutcome,
} from "@crewon/application";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  PROJECT_MEDIA_GENERATE_UI_ACTION,
  parseGenerateProjectMediaResponse,
} from "@crewon/contracts/project-media-generations";
import { uiTestDescriptor } from "../../../packages/application/src/plugin-ui.test-support.ts";
import { mediaGenerationRuntimeFixture } from "./project-media-generation-runtime.test-support.ts";
import { ProjectMediaGenerationPluginUiOwner } from "./project-media-generation-plugin-ui-owner.ts";
import type { ControlApiRequestContext } from "./control-api-ports.ts";

/** Genuine UI invocation + Core/request/HTTP + original SQL. The UI package verifier and PDP are named fixtures.
 * This does not claim native Main publication, installed UI bytes, rendering or an Agent tool. */
export async function mediaGenerationUiFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
  options: {
    declared?: boolean;
    publication?: string;
    kind?: "T10" | "D18";
  } = {},
) {
  const f = await mediaGenerationRuntimeFixture(t, backend, options.kind),
    { tenantId, spaceId, profileId } = f.target.installation,
    scope = { tenantId, spaceId, profileId };
  const descriptor = parsePluginPackageDescriptor({
    ...uiTestDescriptor,
    pluginId: f.reviewedTarget.pluginId,
    publisherId: f.reviewedTarget.publisherId,
    version: f.reviewedTarget.version,
    entrypoints: { node: null, ui: { path: "ui.mjs", mode: "trustedModule" } },
    files: uiTestDescriptor.files.filter((file) => file.path === "ui.mjs"),
    requires:
      options.declared === false
        ? []
        : [
            {
              service: "crewon.project-media-generations",
              apiVersion: "1",
              optional: true,
            },
          ],
  });
  const state = {
    allowed: true,
    contexts: [] as PluginUiActionContext[],
    outcomes: [] as PluginUiCommittedTaskOutcome[],
    afterOutcome: undefined as (() => void) | undefined,
  };
  const owner = new ProjectMediaGenerationPluginUiOwner({
    runtime: f.owner,
    configuration: {
      publications: [
        {
          pluginId: f.target.package.pluginId,
          packageDigest: options.publication ?? f.target.package.packageDigest,
          contributionId: "workbench",
        },
      ],
    },
  });
  t.after(() => owner.close());
  const ui = new PluginUiApplicationService({
    store: f.parent.pluginInstallationStore(),
    profiles: {
      resolve: async () => ({ ...scope, profileId: f.controlState.profileId }),
    },
    authorization: {
      authorize: async () =>
        state.allowed
          ? { outcome: "allow", authorityEpoch: "media-ui-fixture" }
          : { outcome: "deny", reasonCode: "withdrawn" },
    },
    packages: {
      verify: async () => ({ descriptor, publicAssets: ["ui.mjs"] }),
      readAsset: async () => ({
        bytes: new Uint8Array([1]),
        contentType: "text/javascript",
      }),
    },
    clock: f.dependencies.clock,
    ids: { nextId: () => randomUUID().replaceAll("-", "") + "m".repeat(16) },
    actions: {
      invoke: async (context) => {
        state.contexts.push(context);
        const value = await owner.actions.invoke(context);
        if (owner.committedTasks.isOutcome(value)) {
          state.outcomes.push(value);
          state.afterOutcome?.();
        }
        return value;
      },
    },
    committedTasks: owner.committedTasks,
  });
  const mount = await ui.openMount(f.actor, {
    pluginId: f.target.package.pluginId,
    contributionId: "workbench",
    expectedSelectionRevision: f.target.selection.revision,
    expectedPackageDigest: f.target.package.packageDigest,
  });
  const request: ControlApiRequestContext = {
    method: "POST",
    url: "/api/v1/plugin-ui/actions",
    remoteAddress: "127.0.0.1",
    headers: f.request.headers,
  };
  const invoke = async (input = f.command, selectedMount = mount.mountRef) => {
    const result = await f.requests.run({ request, actor: f.actor }, () =>
      ui.invoke(f.actor, {
        mountRef: selectedMount,
        action: PROJECT_MEDIA_GENERATE_UI_ACTION,
        input,
      }),
    );
    return parseGenerateProjectMediaResponse(input, result);
  };
  return {
    ...f,
    descriptor,
    stateUi: state,
    uiOwner: owner,
    ui,
    mount,
    request,
    invoke,
  };
}
