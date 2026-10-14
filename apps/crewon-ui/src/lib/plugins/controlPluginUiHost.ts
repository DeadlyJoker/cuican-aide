import { isPluginUiNavigationAction } from "@crewon/contracts/plugins";
import {
  invokePluginUiNavigation,
  type PluginUiNavigationHandler,
} from "./pluginUiNavigationTransport";
import { createInstalledPluginSourceUploadPartTransport } from "./installedPluginSourceUploadTransport";
import { createInstalledPluginMediaResultTransport } from "./installedPluginMediaResultTransport";
import { isProjectMediaResultUiNamespaceAction } from "@crewon/contracts/project-media-results-ui";
import { PROJECT_MEDIA_GENERATE_UI_ACTION } from "@crewon/contracts/project-media-generations";
import { createInstalledPluginMediaGenerationTransport } from "./installedPluginMediaGenerationTransport";
import { assertInstalledPluginQueryLaneAvailable } from "./installedPluginQueryLaneAvailability";
import { PROJECT_HISTORICAL_QUERY_UI_ACTIONS } from "@crewon/contracts/project-historical-queries";
import { invokeInstalledPluginHistoricalProjectQuery } from "./installedPluginHistoricalProjectQueryTransport";
import type { InstalledPluginProjectHistoricalQueryJournal } from "./installedPluginProjectHistoricalQueryJournal";
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
import { hasPluginEntryByteCache } from "./controlPluginUiCodeCapability";
import { createPluginEntryByteImporter } from "./pluginEntryByteImporter";
import { PluginUiLeaseLifecycle } from "./pluginUiLeaseLifecycle";
import { PluginUiValidationFlights } from "./pluginUiValidationFlights";
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
    onProgress?: (phase: string) => void,
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
    onNavigation?: PluginUiNavigationHandler;
    onTaskReceipt?(event: InstalledPluginTaskReceiptEvent): void;
    onProjectConversationOpen?(
      event: InstalledPluginConversationOpenEvent,
    ): void;
    generationJournal?: InstalledPluginGenerationJournal;
    projectQueryJournal?: InstalledPluginProjectQueryJournal;
    historicalQueryJournal?: InstalledPluginProjectHistoricalQueryJournal;
    selectionJournal?: InstalledPluginProjectSelectionJournal;
    /** Explicit importer injection is for deterministic lifecycle tests; native URL import is the default. */
    importer?: PluginUiModuleImporter;
    /** Stable local account partition, never an HTTP credential or authorization decision. */
    codeCacheOwnerKey?: string;
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
  const validations = new PluginUiValidationFlights();
  let onValidated: (lease: PluginUiLease) => void = () => undefined;
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
    leases
      .validate(input, signal, async (lease) => {
        assertPluginUiCurrent(assertCurrent, signal);
        const checked = await validations.run(
          lease,
          signal,
          async (sharedSignal) => {
            assertPluginUiCurrent(assertCurrent, sharedSignal);
            const result = await pluginUiControlRequest(
              (requestSignal) =>
                client.plugins.validateMount(lease.mountRef, {
                  signal: requestSignal,
                }),
              sharedSignal,
            );
            assertPluginUiCurrent(assertCurrent, sharedSignal);
            if (checkedLeaseIdentity(result) !== checkedLeaseIdentity(lease))
              uiFailure("plugin_ui_lease_identity_mismatch");
            return result;
          },
        );
        // Each waiter must still belong to its own live host scope after the shared GET completes.
        assertPluginUiCurrent(assertCurrent, signal);
        return checked;
      })
      .then((checked) => {
        assertPluginUiCurrent(assertCurrent, signal);
        onValidated(checked);
        return checked;
      })
      .catch((error: unknown) => {
        // A transport outage must not hide withdrawal of the captured session while it was in flight.
        assertPluginUiCurrent(assertCurrent, signal);
        throw error;
      });
  const sourceUploadParts = createInstalledPluginSourceUploadPartTransport({
    client,
    assertCurrent,
  });
  const mediaResults = createInstalledPluginMediaResultTransport({
    client,
    assertCurrent,
    validateLease,
  });
  const mediaGeneration = createInstalledPluginMediaGenerationTransport({
    client,
    assertCurrent,
    stage: recovery.stage,
  });
  const loader = new TrustedPluginUiLoader({
    assetBasePath: "/api/v1/plugins/ui/mounts",
    routeStyle: "control-mount-assets",
    ...(hasPluginEntryByteCache(client) && options.codeCacheOwnerKey
      ? {
          entryImporter: createPluginEntryByteImporter({
            ownerKey: options.codeCacheOwnerKey,
            importModule: options.importer,
          }),
        }
      : {}),
    importer: options.importer,
    ports: {
      writeProjectSourceUploadPart: (lease, locator, bytes, signal) =>
        leases.run(lease, signal, (current) =>
          sourceUploadParts(current, locator, bytes, signal),
        ),
      async validateMount(lease, signal) {
        await validateLease(lease, signal);
      },
      async invoke(originalLease, input) {
        return leases.run(originalLease, input.signal, async (lease) => {
          if (isPluginUiNavigationAction(input.action))
            return invokePluginUiNavigation(lease, input, options.onNavigation);
          if (isProjectMediaResultUiNamespaceAction(input.action))
            return mediaResults.invoke(lease, input);
          if (input.action === PROJECT_MEDIA_GENERATE_UI_ACTION)
            return mediaGeneration(lease, input);
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
          if (input.action === PROJECT_HISTORICAL_QUERY_UI_ACTIONS[0])
            return invokeInstalledPluginHistoricalProjectQuery(
              {
                client,
                assertCurrent,
                journal: options.historicalQueryJournal,
                otherJournal: projectQueryJournal,
              },
              lease,
              input,
            );
          if (input.action === PROJECT_GENERATION_QUERY_UI_ACTIONS[0]) {
            assertInstalledPluginQueryLaneAvailable(
              lease,
              options.historicalQueryJournal,
            );
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
        mediaResults.release(lease);
        leases.release(lease);
        validations.withdraw(lease);
        recovery.release(lease);
        // Revoke the reference through the original authenticated client even after the host changed session.
        await pluginUiControlRequest((signal) =>
          client.plugins.closeMount(lease.mountRef, { signal }),
        );
      },
      onDiagnostic: options.onDiagnostic,
    },
  });
  // Private host notification; plugins receive neither this hook nor the checked lease.
  onValidated = (lease) => loader.resumeDeferredUpdate(lease);
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
          validations.withdraw(previous);
          recovery.renewLease(previous, next);
          loader.renewLease(previous, next);
        },
      );
    },
    async acquireMount(
      input: PluginUiCatalogItem,
      contributionId: string,
      signal: AbortSignal,
      onProgress?: (phase: string) => void,
    ) {
      const progress = (phase: string) => {
        try {
          onProgress?.(phase);
        } catch {
          // Diagnostics never determine authorization or request completion.
        }
      };
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
      progress("open-lease");
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
        progress("recover");
        await recovery.hydrate(lease, signal);
        progress("lease-ready");
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
