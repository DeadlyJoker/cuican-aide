import type { TestContext } from "node:test";
import {
  ProjectConceptSelectionApplicationService,
  PluginUiApplicationService,
  type PluginUiActionContext,
} from "@crewon/application";
import { parsePluginPackageDescriptor } from "@crewon/contracts/plugins";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { ProjectGenerationSelectionPluginUiOwner } from "./project-generation-selection-plugin-ui-owner.ts";
import { registerPluginControlRoutes } from "./plugin-control-route.ts";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { timestamp } from "../../../packages/store/src/extension-store.test-support.ts";
import { generationReadHttpFixture } from "./project-generation-read-route.test-support.ts";
import { createComfyUiProjectGenerationImageResultVerifier } from "./comfyui-image-result-verifier.ts";
import { registerProjectGenerationSelectionRoutes } from "./project-generation-selection-route.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import { ControlApiIdentityError } from "./control-api-ports.ts";
import { PostgresDomainStore } from "@crewon/store";

/** Same actual SQL metadata, paid Turn and persisted operation. Identity/policy/wallet are explicit fixtures. */
export async function conceptSelectionHttpFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  if (backend === "postgres") {
    const open = PostgresDomainStore.open.bind(PostgresDomainStore);
    t.mock.method(
      PostgresDomainStore,
      "open",
      (input: Parameters<typeof open>[0]) => open({ ...input, maxPoolSize: 1 }),
    );
  }
  const f = await generationReadHttpFixture(t, backend);
  const generation = await f.commitGenerationWithResult();
  const binding = generation.committed.binding;
  const configuration = (await f.first.store.loadExtensionConfiguration({
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    pluginId: binding.pluginId,
    revision: binding.configurationRevision,
  }))!;
  const verifier = createComfyUiProjectGenerationImageResultVerifier({
    identities: [
      {
        pluginVersion: configuration.pluginVersion,
        manifestDigest: configuration.manifestDigest,
        implementationDigest: configuration.implementationDigest,
      },
    ],
  });
  const selections = f.first.parent.projectConceptSelectionStore({ verifier });
  await selections.migrateConceptSelections();
  await selections.enableConceptSelectionReads();
  const service = new ProjectConceptSelectionApplicationService({
    projects: {
      store: f.metadata,
      authorization: {
        authorize: async () =>
          f.policy.deniedProject
            ? { outcome: "deny", reasonCode: "selection-project-denied" }
            : { outcome: "allow" },
      },
    },
    generationReads: f.service,
    extensions: f.first.store,
    operations: f.first.parent.externalOperationStore(),
    selections,
    authorization: {
      authorize: async ({ action }) =>
        action === f.policy.deniedTask
          ? { outcome: "deny", reasonCode: "selection-task-denied" }
          : { outcome: "allow" },
    },
    verifier,
    clock: { now: () => timestamp },
    digester: extensionStoreDigester,
  });
  const baseHeaders = f.headers();
  const identity = new StandaloneIdentity({
    actor: f.actor,
    sessionToken: baseHeaders.authorization.slice("Bearer ".length),
    csrfToken: "generation-read-control-csrf-at-least-32",
    allowedOrigins: [baseHeaders.origin],
  });
  const state = { denyIdentity: false };
  registerProjectGenerationSelectionRoutes(f.app, {
    selections: service,
    extensionReads: f.reads,
    identity: {
      resolveActor: async (request) => {
        if (state.denyIdentity)
          throw new ControlApiIdentityError(
            "authentication",
            "session_invalid",
          );
        return identity.resolveActor(request);
      },
    },
  });
  const url = `/api/v1/creative-projects/${encodeURIComponent(f.reference.projectId)}/concepts/${encodeURIComponent(f.reference.assetId)}/selection`;
  const body = (resultIndex = 0, expectedSelectionRevision = 0) => ({
    reference: f.reference,
    operationId: generation.operation.operationId,
    expectedOperationRevision: generation.operation.revision,
    resultIndex,
    expectedSelectionRevision,
  });
  const headers = (key?: string) => ({
    ...baseHeaders,
    "x-csrf-token": "generation-read-control-csrf-at-least-32",
    ...(key === undefined ? {} : { "idempotency-key": key }),
  });
  return {
    ...f,
    generation,
    configuration,
    verifier,
    selections,
    selectionService: service,
    selectionUrl: url,
    selectionBody: body,
    selectionHeaders: headers,
    selectionState: state,
    selectionIdentity: identity,
  };
}

/** Actual SQL installation and registered source UI; byte verification/profile/PDP are explicit fixture ports. */
export async function conceptSelectionInstalledUiFixture(
  t: TestContext,
  backend: "sqlite" | "postgres",
) {
  const f = await conceptSelectionHttpFixture(t, backend);
  const profile = {
    tenantId: f.actor.tenantId,
    spaceId: f.actor.spaceId,
    profileId: f.enabled.selection.profileId,
  };
  const ledger = f.first.parent.pluginInstallationStore();
  const recipe = installationRecipe("selection-ui-source", {
    scope: profile,
    actor: f.actor,
    pluginId: "example.image-selection",
    at: timestamp,
  });
  const installed = await ledger.recordInstalledPackage(recipe);
  const selected = await ledger.commitSelection(
    selectionRecipe(installed.selection, "selection-ui-enabled", {
      actor: f.actor,
      at: timestamp,
    }),
  );
  const descriptor = parsePluginPackageDescriptor({
    schemaVersion: "crewon.plugin-package.v1",
    hostApi: "crewon.plugin-host.v1",
    pluginId: recipe.package.pluginId,
    version: recipe.package.version,
    title: "Image selection",
    description: "Selection fixture",
    publisherId: recipe.package.publisherId,
    entrypoints: { node: null, ui: { path: "ui.mjs", mode: "trustedModule" } },
    businessManifestPath: null,
    requires: [
      {
        service: "crewon.project-generation-selections",
        apiVersion: "1",
        optional: true,
      },
    ],
    provides: [],
    contributions: [
      {
        id: "workbench",
        kind: "module",
        slot: "main.content",
        title: "Selection",
      },
    ],
    files: [{ path: "ui.mjs", byteLength: 1, sha256: "a".repeat(64) }],
  });
  const state = {
    allow: true,
    context: null as PluginUiActionContext | null,
    beforeAuthorize: null as (() => Promise<void>) | null,
    afterOutcome: null as (() => void) | null,
  };
  const owner = new ProjectGenerationSelectionPluginUiOwner({
    configuration: {
      publications: [
        {
          pluginId: recipe.package.pluginId,
          packageDigest: recipe.package.packageDigest,
          contributionId: "workbench",
        },
      ],
    },
    selections: f.selectionService,
    authorization: {
      authorize: async () => {
        await state.beforeAuthorize?.();
        if (!state.allow) throw new Error("selection_ui_request_withdrawn");
      },
    },
  });
  t.after(() => owner.close());
  const ui = new PluginUiApplicationService({
    store: ledger,
    profiles: { resolve: async () => profile },
    authorization: {
      authorize: async () =>
        state.allow
          ? { outcome: "allow", authorityEpoch: "selection-ui-fixture-current" }
          : { outcome: "deny", reasonCode: "selection-ui-denied" },
    },
    packages: {
      verify: async () => ({ descriptor, publicAssets: ["ui.mjs"] }),
      readAsset: async () => ({
        bytes: new Uint8Array([1]),
        contentType: "text/javascript",
      }),
    },
    clock: { now: () => timestamp },
    ids: { nextId: () => "q".repeat(40) },
    actions: {
      invoke: async (context) => {
        state.context = context;
        const value = await owner.actions.invoke(context);
        state.afterOutcome?.();
        return value;
      },
    },
    committedMetadata: owner.committedMetadata,
  });
  registerPluginControlRoutes(f.app, {
    identity: f.selectionIdentity,
    pluginUi: ui,
  });
  const mount = await f.app.inject({
    method: "POST",
    url: "/api/v1/plugins/ui/mounts",
    headers: f.selectionHeaders(),
    payload: {
      pluginId: recipe.package.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: selected.selection.revision,
      expectedPackageDigest: recipe.package.packageDigest,
    },
  });
  if (mount.statusCode !== 200) throw new Error(mount.body);
  const mountRef = mount.json().mountRef as string;
  const actionUrl = `/api/v1/plugins/ui/mounts/${mountRef}/actions`;
  const invoke = (
    input = { ...f.selectionBody(), idempotencyKey: "ui-select-original" },
  ) =>
    f.app.inject({
      method: "POST",
      url: actionUrl,
      headers: f.selectionHeaders(),
      payload: {
        action: "crewon.project-generation-selections.v1.selectConceptImage",
        input,
      },
    });
  return { ...f, ui, owner, uiState: state, mountRef, invoke };
}
