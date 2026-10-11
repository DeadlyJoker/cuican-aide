import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import {
  PluginUiApplicationService,
  type PluginUiActionContext,
  type RecordPluginProjectWorkspaceNamespaceInput,
} from "@crewon/application";
import {
  parsePluginPackageDescriptor,
  parsePluginUiJsonValue,
} from "@crewon/contracts/plugins";
import { parsePluginProjectWorkspaceOwner } from "@crewon/domain";
import {
  uiTestBytes,
  uiTestDescriptor,
} from "../../application/src/plugin-ui.test-support.ts";
import { conversationFixture } from "./project-conversation-store.test-support.ts";
import { timestamp } from "./extension-store.test-support.ts";

/** Actual SQL parent and original Host invocation registry; local package verification/policy are named fixtures. */
export async function workspaceNamespaceFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await conversationFixture(t, backend);
  const state = {
    allowed: true,
    epoch: "namespace-test-epoch",
    context: null as PluginUiActionContext | null,
    beforeWrite: null as (() => void | Promise<void>) | null,
  };
  const owner = (projectId = f.reference.projectId) =>
    parsePluginProjectWorkspaceOwner({
      ...f.actor,
      profileId: f.installation.profileId,
      pluginId: f.installation.pluginId,
      publisherId: f.installation.publisherId,
      projectId,
    });
  const { projectId: _projectId, ...scope } = owner();
  const recipe = (
    projectId = f.reference.projectId,
    workspaceId = "workspace-isolated",
  ): RecordPluginProjectWorkspaceNamespaceInput => ({
    projectId,
    workspaceId,
    createdAt: timestamp,
  });
  async function mounted() {
    const selection = (await f.installs.loadSelection({
      scope: {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        profileId: f.installation.profileId,
      },
      pluginId: f.installation.pluginId,
    }))!;
    const pkg = (await f.installs.loadPackage({
      scope: {
        tenantId: f.actor.tenantId,
        spaceId: f.actor.spaceId,
        profileId: f.installation.profileId,
      },
      packageDigest: selection.selectedPackageDigest!,
    }))!;
    const descriptor = parsePluginPackageDescriptor({
      ...uiTestDescriptor,
      pluginId: pkg.pluginId,
      publisherId: pkg.publisherId,
      version: pkg.version,
      requires: [
        {
          service: "crewon.creative-projects",
          apiVersion: "1",
          optional: false,
        },
      ],
    });
    const service = new PluginUiApplicationService({
      store: f.installs,
      profiles: {
        async resolve() {
          return {
            tenantId: f.actor.tenantId,
            spaceId: f.actor.spaceId,
            profileId: f.installation.profileId,
          };
        },
      },
      authorization: {
        async authorize() {
          return state.allowed
            ? { outcome: "allow", authorityEpoch: state.epoch }
            : { outcome: "deny", reasonCode: "namespace_test_denied" };
        },
      },
      packages: {
        async verify() {
          return { descriptor, publicAssets: ["ui.mjs"] };
        },
        async readAsset() {
          return {
            bytes: uiTestBytes,
            contentType: "text/javascript; charset=utf-8",
          };
        },
      },
      actions: {
        async invoke(context) {
          state.context = context;
          await state.beforeWrite?.();
          return parsePluginUiJsonValue(
            await f.parent.recordPluginProjectWorkspaceNamespaceFromPluginUi(
              context,
              context.input as RecordPluginProjectWorkspaceNamespaceInput,
            ),
          );
        },
      },
      ids: { nextId: () => randomUUID().replaceAll("-", "").repeat(2) },
      clock: { now: () => timestamp },
    });
    const lease = await service.openMount(f.actor, {
      pluginId: pkg.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: selection.revision,
      expectedPackageDigest: pkg.packageDigest,
    });
    return {
      service,
      lease,
      write(input = recipe()) {
        return service.invoke(f.actor, {
          mountRef: lease.mountRef,
          action: "crewon.creative-projects.v1.createProject",
          input: { ...input },
        });
      },
    };
  }
  return {
    ...f,
    namespaceState: state,
    namespaceOwner: owner,
    namespaceScope: scope,
    namespaceRecipe: recipe,
    mounted,
  };
}
