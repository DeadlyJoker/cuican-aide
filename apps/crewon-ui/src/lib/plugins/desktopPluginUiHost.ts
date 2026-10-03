import {
  parsePluginUiCatalogResponse,
  type PluginUiCatalogItem,
} from "@crewon/contracts";
import {
  parsePluginUiLease,
  PROJECT_GENERATION_UI_ACTIONS,
  PROJECT_GENERATION_QUERY_UI_ACTIONS,
  parseProjectGenerationUiActionRequest,
  parseProjectGenerationQueryUiActionRequest,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import type { ControlApiClient } from "@crewon/control-client";
import { getDesktopBridge } from "../desktop/desktopBridge";
import {
  DESKTOP_PLUGIN_UI_VERSION,
  desktopPluginUiAssetUrl,
  type DesktopPluginUiAssets,
  type DesktopPluginUiBinding,
} from "../desktop/desktopPluginUiProtocol";
import {
  TrustedPluginUiLoader,
  importTrustedPluginUiModule,
  type PluginUiModuleImporter,
} from "./trustedPluginUiLoader";
import { uiFailure, uiRecord, pluginUiAssetUrl } from "./pluginUiValidation";
import {
  assertPluginUiCurrent,
  checkedLeaseIdentity,
  pluginUiCatalogIdentity,
  pluginUiControlRequest,
  type PluginUiCurrentScope,
} from "./controlPluginUiSupport";
import type { ControlPluginUiHost } from "./controlPluginUiHost";
import {
  createInstalledPluginTaskReceiptTransport,
  type InstalledPluginTaskReceiptEvent,
} from "./installedPluginTaskReceipt";
import type { InstalledPluginGenerationJournal } from "./installedPluginGenerationJournal";
import type { InstalledPluginProjectQueryJournal } from "./installedPluginProjectQueryJournal";

export function installedDesktopPluginUiAssets(): DesktopPluginUiAssets | null {
  const assets = getDesktopBridge()?.pluginUiAssets;
  return assets?.version === DESKTOP_PLUGIN_UI_VERSION &&
    typeof assets.adopt === "function" &&
    typeof assets.release === "function" &&
    typeof assets.invalidate === "function"
    ? assets
    : null;
}

/** Native ESM adapter. Only the actual main-process broker receives Control asset credentials. */
export function createDesktopPluginUiHost(
  options: Readonly<{
    client: ControlApiClient;
    assets: DesktopPluginUiAssets;
    assertCurrent: PluginUiCurrentScope;
    onDiagnostic(error: unknown): void;
    onTaskReceipt?(event: InstalledPluginTaskReceiptEvent): void;
    generationJournal?: InstalledPluginGenerationJournal;
    projectQueryJournal?: InstalledPluginProjectQueryJournal;
    importer?: PluginUiModuleImporter;
  }>,
): ControlPluginUiHost {
  if (
    typeof location === "undefined" ||
    location.protocol !== "file:" ||
    options.assets.version !== DESKTOP_PLUGIN_UI_VERSION
  )
    uiFailure("plugin_ui_transport_unsupported");
  const { client, assertCurrent, generationJournal, projectQueryJournal } =
    options;
  const taskReceiptTransport = options.onTaskReceipt
    ? createInstalledPluginTaskReceiptTransport({
        assertCurrent,
        onTaskReceipt: options.onTaskReceipt,
        onDiagnostic: options.onDiagnostic,
      })
    : null;
  const adopt = options.assets.adopt.bind(options.assets);
  const release = options.assets.release.bind(options.assets);
  const invalidate = options.assets.invalidate.bind(options.assets);
  const importer = options.importer ?? importTrustedPluginUiModule;
  const bindings = new Map<
    string,
    Readonly<{ binding: DesktopPluginUiBinding; identity: string }>
  >();
  const entryUrls = new Map<string, string>();
  const validateLease = async (input: PluginUiLease, signal: AbortSignal) => {
    const lease = parsePluginUiLease(input);
    assertPluginUiCurrent(assertCurrent, signal);
    const checked = await pluginUiControlRequest(
      (s) => client.plugins.validateMount(lease.mountRef, { signal: s }),
      signal,
    );
    assertPluginUiCurrent(assertCurrent, signal);
    if (checkedLeaseIdentity(checked) !== checkedLeaseIdentity(lease))
      uiFailure("plugin_ui_lease_identity_mismatch");
    return checked;
  };
  const loader = new TrustedPluginUiLoader({
    assetBasePath: "/api/v1/plugins/ui/mounts",
    routeStyle: "control-mount-assets",
    importer: async (url) => {
      assertPluginUiCurrent(assertCurrent);
      const nativeUrl = entryUrls.get(url);
      if (!nativeUrl) uiFailure("plugin_ui_native_binding_unavailable");
      return importer(nativeUrl);
    },
    ports: {
      async validateMount(lease, signal) {
        await validateLease(lease, signal);
      },
      async invoke(lease, input) {
        if (input.action === PROJECT_GENERATION_QUERY_UI_ACTIONS[0]) {
          if (!projectQueryJournal)
            uiFailure("plugin_ui_project_query_journal_unavailable");
          const query = parseProjectGenerationQueryUiActionRequest({
            action: input.action,
            input: input.input,
          });
          const response = await projectQueryJournal.invoke({
            lease,
            input: query.input,
            signal: input.signal,
            assertCurrent,
            request: (signal) =>
              client.plugins.invoke(lease.mountRef, query, { signal }),
          });
          assertPluginUiCurrent(assertCurrent, input.signal);
          return response.output;
        }
        if (input.action === PROJECT_GENERATION_UI_ACTIONS[0]) {
          if (!generationJournal)
            uiFailure("plugin_ui_generation_journal_unavailable");
          const generation = parseProjectGenerationUiActionRequest({
            action: input.action,
            input: input.input,
          });
          const response = await generationJournal.invoke({
            lease,
            input: generation.input,
            signal: input.signal,
            assertCurrent,
            request: (signal) =>
              client.plugins.invoke(lease.mountRef, generation, { signal }),
          });
          assertPluginUiCurrent(assertCurrent, input.signal);
          return response.output;
        }
        assertPluginUiCurrent(assertCurrent, input.signal);
        const request = (signal: AbortSignal) =>
          client.plugins.invoke(
            lease.mountRef,
            { action: input.action, input: input.input },
            { signal },
          );
        const response = await (taskReceiptTransport
          ? taskReceiptTransport(lease, input.signal, request)
          : pluginUiControlRequest(request, input.signal));
        assertPluginUiCurrent(assertCurrent, input.signal);
        return response.output;
      },
      async closeMount(lease) {
        const owned = bindings.get(lease.mountRef);
        if (owned) {
          if (owned.identity !== checkedLeaseIdentity(lease))
            uiFailure("plugin_ui_lease_identity_mismatch");
          await release(owned.binding.bindingRef);
          bindings.delete(lease.mountRef);
          entryUrls.delete(
            pluginUiAssetUrl(
              "/api/v1/plugins/ui/mounts",
              lease.mountRef,
              lease.descriptor.entrypoints.ui!.path,
              "control-mount-assets",
            ),
          );
        } else
          await pluginUiControlRequest((s) =>
            client.plugins.closeMount(lease.mountRef, { signal: s }),
          );
      },
      onDiagnostic: options.onDiagnostic,
    },
  });
  return Object.freeze({
    loader,
    validateLease,
    async acquireMount(
      input: PluginUiCatalogItem,
      contributionId: string,
      signal: AbortSignal,
    ) {
      const item = parsePluginUiCatalogResponse(
        { plugins: [input], next: null },
        { afterPluginId: null, limit: 1 },
      ).plugins[0];
      const contribution = item.descriptor.contributions.find(
        (v) => v.id === contributionId,
      );
      if (
        contribution?.kind !== "module" ||
        contribution.slot !== "main.content"
      )
        uiFailure("plugin_ui_contribution_invalid");
      assertPluginUiCurrent(assertCurrent, signal);
      const lease = await pluginUiControlRequest((s) =>
        client.plugins.openMount(
          {
            pluginId: item.descriptor.pluginId,
            contributionId,
            expectedSelectionRevision: item.selectionRevision,
            expectedPackageDigest: item.packageDigest,
          },
          { signal: s },
        ),
      );
      try {
        assertPluginUiCurrent(assertCurrent, signal);
        if (pluginUiCatalogIdentity(lease) !== pluginUiCatalogIdentity(item))
          uiFailure("plugin_ui_lease_identity_mismatch");
        // Do not race away a successful allocation response: the adopter is the new sole physical close owner.
        const value = await adopt({
          lease,
          expectedControlOrigin: client.requestOrigin,
        });
        let binding: DesktopPluginUiBinding;
        try {
          const record = uiRecord(value);
          if (
            Object.keys(record).length !== 3 ||
            typeof record.bindingRef !== "string" ||
            record.entryUrl !==
              desktopPluginUiAssetUrl(
                record.bindingRef,
                lease.descriptor.entrypoints.ui!.path,
              ) ||
            record.controlOrigin !== client.requestOrigin
          )
            uiFailure("plugin_ui_native_binding_invalid");
          binding = Object.freeze({
            bindingRef: record.bindingRef,
            entryUrl: record.entryUrl as string,
            controlOrigin: record.controlOrigin as string,
          });
        } catch (error) {
          // A malformed trusted IPC result must not leave an unobservable native allocation behind.
          await invalidate();
          throw error;
        }
        bindings.set(
          lease.mountRef,
          Object.freeze({ binding, identity: checkedLeaseIdentity(lease) }),
        );
        entryUrls.set(
          pluginUiAssetUrl(
            "/api/v1/plugins/ui/mounts",
            lease.mountRef,
            lease.descriptor.entrypoints.ui!.path,
            "control-mount-assets",
          ),
          binding.entryUrl,
        );
        assertPluginUiCurrent(assertCurrent, signal);
        return lease;
      } catch (error) {
        try {
          await loader.closeUnusedMount(lease);
        } catch {
          /* The existing loader retains and reports failed cleanup. */
        }
        throw error;
      }
    },
  });
}
