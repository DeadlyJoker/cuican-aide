import { createInstalledPluginUiRecovery } from "./installedPluginUiRecovery";
import type { InstalledPluginProjectSelectionJournal } from "./installedPluginProjectSelectionJournal";
import {
  parsePluginUiCatalogResponse,
  type PluginUiCatalogItem,
} from "@crewon/contracts";
import {
  PROJECT_GENERATION_UI_ACTIONS,
  PROJECT_GENERATION_QUERY_UI_ACTIONS,
  PROJECT_GENERATION_SELECTION_UI_ACTIONS,
  parseProjectGenerationSelectionUiActionRequest,
  parseProjectGenerationSelectionUiActionResponse,
  parseProjectGenerationUiActionRequest,
  parseProjectGenerationQueryUiActionRequest,
  type PluginUiLease,
} from "@crewon/contracts/plugins";
import type { ControlApiClient } from "@crewon/control-client";
import {
  TrustedPluginUiLoader,
  type PluginUiModuleImporter,
} from "./trustedPluginUiLoader";
import { uiFailure } from "./pluginUiValidation";
import { PluginUiLeaseLifecycle } from "./pluginUiLeaseLifecycle";
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
import type { InstalledPluginGenerationJournal } from "./installedPluginGenerationJournal";
import type { InstalledPluginProjectQueryJournal } from "./installedPluginProjectQueryJournal";
import {
  invokeInstalledPluginConversation,
  isInstalledPluginConversationAction,
  type InstalledPluginConversationOpenEvent,
} from "./installedPluginConversationTransport";

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
  /** Optional for compatibility with older native bridges. Never reopens an expired mount. */
  renewLease?(
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
    onProjectConversationOpen?(
      event: InstalledPluginConversationOpenEvent,
    ): void;
    generationJournal?: InstalledPluginGenerationJournal;
    projectQueryJournal?: InstalledPluginProjectQueryJournal;
    selectionJournal?: InstalledPluginProjectSelectionJournal;
    /** Explicit importer injection is for deterministic lifecycle tests; native URL import is the default. */
    importer?: PluginUiModuleImporter;
  }>,
): ControlPluginUiHost {
  const {
    client,
    assertCurrent,
    generationJournal,
    projectQueryJournal,
    selectionJournal,
  } = options;
  const recovery = createInstalledPluginUiRecovery(options);
  const leases = new PluginUiLeaseLifecycle();
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

  const validateLease = (
    input: PluginUiLease,
    signal: AbortSignal,
  ): Promise<PluginUiLease> =>
    leases.validate(input, signal, async (lease) => {
      assertPluginUiCurrent(assertCurrent, signal);
      const checked = await pluginUiControlRequest(
        (requestSignal) =>
          client.plugins.validateMount(lease.mountRef, {
            signal: requestSignal,
          }),
        signal,
      );
      assertPluginUiCurrent(assertCurrent, signal);
      if (checkedLeaseIdentity(checked) !== checkedLeaseIdentity(lease))
        uiFailure("plugin_ui_lease_identity_mismatch");
      return checked;
    });
  const loader = new TrustedPluginUiLoader({
    assetBasePath: "/api/v1/plugins/ui/mounts",
    routeStyle: "control-mount-assets",
    importer: options.importer,
    ports: {
      async validateMount(lease, signal) {
        await validateLease(lease, signal);
      },
      async invoke(originalLease, input) {
        return leases.run(originalLease, input.signal, async (lease) => {
          if (isInstalledPluginConversationAction(input.action))
            return invokeInstalledPluginConversation(
              {
                client,
                assertCurrent,
                ...(options.onProjectConversationOpen === undefined
                  ? {}
                  : { onOpen: options.onProjectConversationOpen }),
              },
              lease,
              input,
            );
          if (
            PROJECT_GENERATION_SELECTION_UI_ACTIONS.some(
              (action) => action === input.action,
            )
          ) {
            const selection = parseProjectGenerationSelectionUiActionRequest({
              action: input.action,
              input: input.input,
            });
            if (
              selection.action === PROJECT_GENERATION_SELECTION_UI_ACTIONS[1]
            ) {
              if (!selectionJournal)
                uiFailure("plugin_ui_project_selection_journal_unavailable");
              const response = await selectionJournal.invoke({
                lease,
                input: selection.input,
                stage: recovery.stage(lease, selection),
                signal: input.signal,
                assertCurrent,
                request: (signal) =>
                  client.plugins.invoke(lease.mountRef, selection, { signal }),
              });
              assertPluginUiCurrent(assertCurrent, input.signal);
              return response.output;
            }
            // GET is an authenticated observation, separate from all mutation/task journals.
            assertPluginUiCurrent(assertCurrent, input.signal);
            const response = await pluginUiControlRequest(
              (signal) =>
                client.plugins.invoke(lease.mountRef, selection, { signal }),
              input.signal,
            );
            assertPluginUiCurrent(assertCurrent, input.signal);
            return parseProjectGenerationSelectionUiActionResponse(
              selection,
              response.output,
            );
          }
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
              stage: recovery.stage(lease, query),
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
              stage: recovery.stage(lease, generation),
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
        });
      },
      async closeMount(lease) {
        leases.release(lease);
        recovery.release(lease);
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
    renewLease(lease, signal) {
      return leases.renew(
        lease,
        signal,
        (previous, renewalSignal) => {
          assertPluginUiCurrent(assertCurrent, renewalSignal);
          return pluginUiControlRequest(
            (requestSignal) =>
              client.plugins.renewMount(
                previous.mountRef,
                { expectedExpiresAt: previous.expiresAt },
                { signal: requestSignal },
              ),
            renewalSignal,
          ).then((next) => {
            assertPluginUiCurrent(assertCurrent, renewalSignal);
            return next;
          });
        },
        (previous, next) => {
          recovery.renewLease(previous, next);
          loader.renewLease(previous, next);
        },
      );
    },
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
        leases.register(lease);
        await recovery.hydrate(lease, signal);
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
