import {
  parsePluginUiCatalogResponse,
  type PluginUiCatalogItem,
} from "@crewon/contracts";
import {
  parsePluginUiLease,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import type { ControlApiClient } from "@crewon/control-client";
import {
  TrustedPluginUiLoader,
  type PluginUiModuleImporter,
} from "./trustedPluginUiLoader";
import { uiFailure } from "./pluginUiValidation";
import {
  createInstalledPluginTaskReceiptTransport,
  type InstalledPluginTaskReceiptEvent,
} from "./installedPluginTaskReceipt";
import {
  assertPluginUiCurrent,
  checkedLeaseIdentity,
  pluginUiCatalogIdentity,
  pluginUiControlRequest,
  type PluginUiCurrentScope,
} from "./controlPluginUiSupport";

export { checkedLeaseIdentity } from "./controlPluginUiSupport";
export type ControlPluginUiHost = Readonly<{
  loader: TrustedPluginUiLoader;
  acquireMount(
    item: PluginUiCatalogItem,
    contributionId: string,
    signal: AbortSignal,
  ): Promise<PluginUiLease>;
  validateLease(
    lease: PluginUiLease,
    signal: AbortSignal,
  ): Promise<PluginUiLease>;
}>;

/** Web BFF adapter. A file:// renderer needs an authenticated native-import broker, which is not provided here. */
export function createControlPluginUiHost(
  options: Readonly<{
    client: ControlApiClient;
    assertCurrent: PluginUiCurrentScope;
    onDiagnostic(error: unknown): void;
    onTaskReceipt?(event: InstalledPluginTaskReceiptEvent): void;
    /** Explicit importer injection is for deterministic lifecycle tests; native URL import is the default. */
    importer?: PluginUiModuleImporter;
  }>,
): ControlPluginUiHost {
  const { client, assertCurrent } = options;
  const taskReceiptTransport = options.onTaskReceipt
    ? createInstalledPluginTaskReceiptTransport({
        assertCurrent,
        onTaskReceipt: options.onTaskReceipt,
        onDiagnostic: options.onDiagnostic,
      })
    : null;
  if (
    typeof location === "undefined" ||
    (location.protocol !== "https:" && location.protocol !== "http:")
  )
    uiFailure("plugin_ui_transport_unsupported");
  if (client.requestOrigin !== location.origin)
    uiFailure("plugin_ui_asset_origin_mismatch");

  const validateLease = async (
    input: PluginUiLease,
    signal: AbortSignal,
  ): Promise<PluginUiLease> => {
    const lease = parsePluginUiLease(input);
    assertPluginUiCurrent(assertCurrent, signal);
    const checked = await pluginUiControlRequest(
      (requestSignal) =>
        client.plugins.validateMount(lease.mountRef, { signal: requestSignal }),
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
    importer: options.importer,
    ports: {
      async validateMount(lease, signal) {
        await validateLease(lease, signal);
      },
      async invoke(lease, input) {
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
        // Revoke the reference through the original authenticated client even after the host changed session.
        await pluginUiControlRequest((signal) =>
          client.plugins.closeMount(lease.mountRef, { signal }),
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
        (entry) => entry.id === contributionId,
      );
      if (
        contribution?.kind !== "module" ||
        contribution.slot !== "main.content"
      )
        uiFailure("plugin_ui_contribution_invalid");
      assertPluginUiCurrent(assertCurrent, signal);
      // Do not hide a newly allocated reference by cancelling this small response read with the caller's signal.
      const lease = await pluginUiControlRequest((requestSignal) =>
        client.plugins.openMount(
          {
            pluginId: item.descriptor.pluginId,
            contributionId,
            expectedSelectionRevision: item.selectionRevision,
            expectedPackageDigest: item.packageDigest,
          },
          { signal: requestSignal },
        ),
      );
      try {
        assertPluginUiCurrent(assertCurrent);
        if (pluginUiCatalogIdentity(lease) !== pluginUiCatalogIdentity(item))
          uiFailure("plugin_ui_lease_identity_mismatch");
      } catch (error) {
        try {
          await loader.closeUnusedMount(lease);
        } catch {
          /* Loader reports and retains this failed cleanup. */
        }
        throw error;
      }
      // PluginModuleMount owns a late, cancelled result and immediately closes its reference.
      return lease;
    },
  });
}
