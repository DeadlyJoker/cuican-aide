import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import type { TestContext } from "node:test";
import type {
  ActorContext,
  CreativeProjectAuthorizationPort,
  InvokePluginUiActionCommand,
} from "@crewon/application";
import { installLocalPluginPackage } from "@crewon/plugin-host";
import { SqliteRunStore } from "@crewon/store";
import {
  installationRecipe,
  selectionRecipe,
} from "../../../packages/store/src/plugin-installation-store.test-support.ts";
import { extensionStoreDigester } from "../../../packages/store/src/extension-store-records.ts";
import { timestamp } from "../../../packages/store/src/extension-store.test-support.ts";
import { conceptSelectionHttpFixture } from "./project-generation-selection-route.test-support.ts";
import { productionSourceFixture } from "./production-plugin-source.test-support.ts";
import { prepareCreativeProjects } from "./creative-project-composition.ts";
import { parseDesktopPluginConfiguration } from "./desktop-plugin-configuration.ts";
import { createDesktopPluginRuntime } from "./desktop-plugin-runtime.ts";
import { StandaloneIdentity } from "./standalone-adapters.ts";
import type { ControlApiRequestContext } from "./control-api-ports.ts";

export const nativeHistoryReadAction =
  "crewon.project-generation-reads.v1.getConceptGeneration";
export const nativeHistorySelectAction =
  "crewon.project-generation-selections.v1.selectConceptImage";
export const nativeHistoryCurrentAction =
  "crewon.project-generation-selections.v1.getConceptSelection";
export type NativeHistoryGrant = "history" | "metadata" | "read-only";

/** Real file-backed SQL paid history and exact installed source UI bytes. The historical
 * target package identity, funding and provider observation are explicitly synthetic fixtures.
 * Native history never loads that target's code, starts a Worker or obtains a live quote. */
export async function nativeProjectHistoryFixture(
  t: TestContext,
  options: Readonly<{
    requiredRecovery?: boolean;
    requiredHistory?: boolean;
  }> = {},
) {
  let runtime:
    | Awaited<ReturnType<typeof createDesktopPluginRuntime>>
    | undefined;
  // Close the borrowed Native owner before SQL fixture cleanup under either hook order.
  t.after(async () => {
    await runtime?.close();
  });
  const history = await conceptSelectionHttpFixture(t, "sqlite");
  assert.ok(history.first.parent instanceof SqliteRunStore);
  let parent = history.first.parent;
  const files = await productionSourceFixture(t, {
    beforeCleanup: async () => {
      await runtime?.close();
    },
  });
  const sourceOptions = {
    pluginId: "test.native-historical-image-ui",
    uiOnly: true,
    requires: [
      ...(options.requiredRecovery
        ? [
            {
              service: "crewon.plugin-ui-recovery",
              apiVersion: "1",
              optional: false,
            },
          ]
        : []),
      { service: "crewon.creative-projects", apiVersion: "1", optional: true },
      {
        service: "crewon.project-generation-reads",
        apiVersion: "1",
        optional: !options.requiredHistory,
      },
      {
        service: "crewon.project-generation-selections",
        apiVersion: "1",
        optional: !options.requiredHistory,
      },
    ],
  };
  const v1 = await files.source("native-history-ui-v1", sourceOptions);
  const v2 = await files.source("native-history-ui-v2", {
    ...sourceOptions,
    version: "2.0.0",
  });
  const scope = {
    tenantId: history.actor.tenantId,
    spaceId: history.actor.spaceId,
    profileId: history.enabled.selection.profileId,
  };
  const ledger = parent.pluginInstallationStore();
  const installedV1 = await installLocalPluginPackage({
    directory: v1.directory,
    installRoot: files.installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  const original = await ledger.recordInstalledPackage(
    installationRecipe("named-native-history-ui-install-v1", {
      scope,
      actor: history.actor,
      pluginId: v1.pluginId,
      publisherId: v1.publisherId,
      version: v1.version,
      packageDigest: installedV1.packageDigest,
    }),
  );
  // Mandatory recovery fixtures stay disabled until the actual Native select port decides.
  const selected =
    options.requiredRecovery || options.requiredHistory
      ? original
      : await ledger.commitSelection(
          selectionRecipe(
            original.selection,
            "named-native-history-ui-enable-v1",
            {
              actor: history.actor,
            },
          ),
        );
  const installedV2 = await installLocalPluginPackage({
    directory: v2.directory,
    installRoot: files.installRoot,
    authorization: async () => ({ outcome: "allow" }),
  });
  await ledger.recordInstalledPackage(
    installationRecipe("named-native-history-ui-install-v2", {
      scope,
      actor: history.actor,
      pluginId: v2.pluginId,
      publisherId: v2.publisherId,
      version: v2.version,
      packageDigest: installedV2.packageDigest,
      expectedSelectionRevision: selected.selection.revision,
    }),
  );
  const publications = [v1, v2].map((source) => ({
    pluginId: source.pluginId,
    packageDigest: source.packageDigest,
    contributionId: "workbench",
  }));
  const configuration = parseDesktopPluginConfiguration({
    schemaVersion: "crewon.desktop-plugin-bootstrap.v1",
    actor: history.actor,
    scope,
    authorityEpoch: "named-native-cold-history-approval-epoch-01",
    installRoot: files.installRoot,
    sources: [v1, v2].map(({ descriptor: _descriptor, ...source }) => source),
    publications: [v1, v2].map((source) => ({
      pluginId: source.pluginId,
      publisherId: source.publisherId,
      packageDigest: source.packageDigest,
      publicAssets: ["ui.mjs"],
    })),
  });
  const token = "named-native-history-session-at-least-32-characters";
  const csrf = "named-native-history-csrf-at-least-32-characters";
  const identity = new StandaloneIdentity({
    actor: history.actor,
    sessionToken: token,
    csrfToken: csrf,
    allowedOrigins: ["crewon://desktop"],
  });
  const authorization: CreativeProjectAuthorizationPort = {
    authorize: async ({ actor, resource }) =>
      !history.policy.deniedProject &&
      Object.entries(history.actor).every(
        ([key, value]) => actor[key as keyof ActorContext] === value,
      ) &&
      resource.tenantId === scope.tenantId &&
      resource.spaceId === scope.spaceId
        ? { outcome: "allow" }
        : {
            outcome: "deny",
            reasonCode: "named-native-history-project-denied",
          },
  };
  function request(
    headers: ControlApiRequestContext["headers"] = {},
    remoteAddress = "127.0.0.1",
  ): ControlApiRequestContext {
    return {
      method: "POST",
      url: "/api/v1/plugins/ui/mounts/named-native-history/actions",
      remoteAddress,
      headers: {
        "authorization": `Bearer ${token}`,
        "origin": "crewon://desktop",
        "x-csrf-token": csrf,
        ...headers,
      },
    };
  }
  async function open(grant: NativeHistoryGrant = "history") {
    assert.equal(
      runtime,
      undefined,
      "the original Native owner must close first",
    );
    const creativeProjects = await prepareCreativeProjects(parent, {
      authorization,
      ...(grant === "metadata"
        ? { pluginUi: { publications } }
        : {
            generationReads: {
              version: "crewon.project-generation-read.v1" as const,
            },
            generationReadUi: { publications },
          }),
      ...(grant !== "history"
        ? {}
        : {
            resultSelections: {
              version: "crewon.project-concept-selection.v1" as const,
              verifier: history.verifier,
            },
            selectionUi: { publications },
          }),
    });
    runtime = await createDesktopPluginRuntime(
      { configuration },
      {
        store: parent,
        identity,
        clock: { now: () => timestamp },
        digester: extensionStoreDigester,
        creativeProjects,
      },
    );
    return runtime;
  }
  async function close() {
    const current = runtime;
    runtime = undefined;
    await current?.close();
  }
  async function coldReopen(grant: NativeHistoryGrant = "history") {
    await close();
    await parent.close();
    await history.second.parent.close();
    const next = await history.open();
    assert.ok(next.parent instanceof SqliteRunStore);
    parent = next.parent;
    return open(grant);
  }
  async function mount() {
    assert.ok(runtime);
    const current = await parent.pluginInstallationStore().loadSelection({
      scope,
      pluginId: v1.pluginId,
    });
    assert.ok(current?.selectedPackageDigest);
    return runtime.ui.openMount(history.actor, {
      pluginId: v1.pluginId,
      contributionId: "workbench",
      expectedSelectionRevision: current.revision,
      expectedPackageDigest: current.selectedPackageDigest,
    });
  }
  async function invoke(
    command: InvokePluginUiActionCommand,
    options: Readonly<{
      request?: ControlApiRequestContext;
      actor?: ActorContext;
      signal?: AbortSignal;
    }> = {},
  ) {
    assert.ok(runtime);
    const authenticated = runtime.ui.invokeAuthenticatedRequest;
    assert.equal(
      typeof authenticated,
      "function",
      "actual Native request adapter",
    );
    return {
      output: await authenticated!.call(
        runtime.ui,
        options.request ?? request(),
        options.actor ?? history.actor,
        command,
        options.signal ?? new AbortController().signal,
      ),
    };
  }
  const locator = {
    projectId: history.reference.projectId,
    assetId: history.reference.assetId,
    assetRevision: history.reference.assetRevision,
  };
  const selectionInput = (
    key = "named-native-select-original",
    resultIndex = 0,
    expectedSelectionRevision = 0,
  ) => ({
    ...history.selectionBody(resultIndex, expectedSelectionRevision),
    idempotencyKey: key,
  });
  const effects = async () => ({
    counts: await history.counts(),
    wallet: await parent.pluginCreditStore().getAccount(history.creditScope),
    hostCalls: history.policy.hostCalls,
  });
  const currentSelection = async () => {
    const selections = parent.projectConceptSelectionStore({
      verifier: history.verifier,
    });
    await selections.enableConceptSelectionReads();
    return selections.loadCurrentConceptSelection({
      owner: {
        tenantId: history.actor.tenantId,
        spaceId: history.actor.spaceId,
        principalId: history.actor.principalId,
      },
      projectId: locator.projectId,
      assetId: locator.assetId,
    });
  };
  const assertNoNodeImport = () =>
    assert.rejects(access(files.marker), { code: "ENOENT" });
  t.after(close);
  return {
    history,
    files,
    v1,
    v2,
    scope,
    configuration,
    identity,
    open,
    close,
    coldReopen,
    mount,
    invoke,
    request,
    locator,
    selectionInput,
    effects,
    currentSelection,
    assertNoNodeImport,
    parent: () => parent,
    runtime: () => {
      assert.ok(runtime);
      return runtime;
    },
  };
}
