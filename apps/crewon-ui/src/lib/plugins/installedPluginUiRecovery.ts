import {
  CREWON_PLUGIN_UI_RECOVERY_API_VERSION,
  CREWON_PLUGIN_UI_RECOVERY_SERVICE,
  parsePluginUiRecoveryHintsResponse,
  parsePluginUiRecoveryHint,
  parseStagePluginUiRecoveryResponse,
  PROJECT_GENERATION_UI_ACTIONS,
  PROJECT_GENERATION_QUERY_UI_ACTIONS,
  PROJECT_GENERATION_SELECTION_UI_ACTIONS,
  type PluginUiLease,
  type PluginUiRecoveryRequest,
} from "@crewon/contracts/plugins";
import type { ControlApiClient } from "@crewon/control-client";
import {
  assertPluginUiCurrent,
  checkedLeaseIdentity,
  pluginUiControlRequest,
  type PluginUiCurrentScope,
} from "./controlPluginUiSupport";
import type { InstalledPluginGenerationJournal } from "./installedPluginGenerationJournal";
import type { InstalledPluginProjectQueryJournal } from "./installedPluginProjectQueryJournal";
import type { InstalledPluginProjectSelectionJournal } from "./installedPluginProjectSelectionJournal";
import { uiFailure } from "./pluginUiValidation";

export function installedPluginUiDeclaresRecovery(
  lease: PluginUiLease,
): boolean {
  return lease.descriptor.requires.some(
    (requirement) =>
      requirement.service === CREWON_PLUGIN_UI_RECOVERY_SERVICE &&
      requirement.apiVersion === CREWON_PLUGIN_UI_RECOVERY_API_VERSION,
  );
}

/** Current mount authentication is always performed by the real Control transport. */
export function createInstalledPluginUiRecovery(
  options: Readonly<{
    client: ControlApiClient;
    assertCurrent: PluginUiCurrentScope;
    generationJournal?: InstalledPluginGenerationJournal;
    projectQueryJournal?: InstalledPluginProjectQueryJournal;
    selectionJournal?: InstalledPluginProjectSelectionJournal;
  }>,
) {
  const { client, assertCurrent } = options;
  const hydrated = new Map<string, string>();
  return Object.freeze({
    async hydrate(lease: PluginUiLease, signal: AbortSignal): Promise<void> {
      if (!installedPluginUiDeclaresRecovery(lease)) return;
      assertPluginUiCurrent(assertCurrent, signal);
      const response = parsePluginUiRecoveryHintsResponse(
        await pluginUiControlRequest(
          (requestSignal) =>
            client.plugins.getRecovery(lease.mountRef, {
              signal: requestSignal,
            }),
          signal,
        ),
      );
      assertPluginUiCurrent(assertCurrent, signal);
      for (const hint of response.intents) {
        if (
          hint.sourcePin.pluginId !== lease.descriptor.pluginId ||
          hint.sourcePin.contributionId !== lease.contributionId
        )
          uiFailure("plugin_ui_recovery_family_mismatch");
      }
      const hints = response.intents.map((hint) => {
        const selection =
          hint.request.action === PROJECT_GENERATION_SELECTION_UI_ACTIONS[1];
        const matched =
          hint.sourcePin.publisherId === lease.descriptor.publisherId &&
          hint.sourcePin.version === lease.descriptor.version &&
          hint.sourcePin.packageDigest === lease.packageDigest &&
          (selection ||
            hint.sourcePin.selectionRevision === lease.selectionRevision);
        return matched || !hint.retryable
          ? hint
          : parsePluginUiRecoveryHint({
              ...hint,
              retryable: false,
              reasonCode:
                hint.reasonCode ?? "plugin_ui_recovery_source_changed",
            });
      });
      const lanes = [
        [PROJECT_GENERATION_UI_ACTIONS[0], options.generationJournal],
        [PROJECT_GENERATION_QUERY_UI_ACTIONS[0], options.projectQueryJournal],
        [PROJECT_GENERATION_SELECTION_UI_ACTIONS[1], options.selectionJournal],
      ] as const;
      const plans = lanes.flatMap(([action, journal]) => {
        if (!journal) {
          if (hints.some((hint) => hint.request.action === action))
            uiFailure("plugin_ui_recovery_journal_unavailable");
          return [];
        }
        return [journal.restore(hints)];
      });
      assertPluginUiCurrent(assertCurrent, signal);
      for (const plan of plans) plan.commit();
      // All three snapshots are complete before any listener can observe one lane.
      for (const plan of plans) plan.publish();
      assertPluginUiCurrent(assertCurrent, signal);
      hydrated.set(lease.mountRef, checkedLeaseIdentity(lease));
    },
    stage(lease: PluginUiLease, request: PluginUiRecoveryRequest) {
      if (!installedPluginUiDeclaresRecovery(lease)) return undefined;
      return async (signal: AbortSignal) => {
        assertPluginUiCurrent(assertCurrent, signal);
        if (hydrated.get(lease.mountRef) !== checkedLeaseIdentity(lease))
          uiFailure("plugin_ui_recovery_not_ready");
        const ack = parseStagePluginUiRecoveryResponse(
          await client.plugins.stageRecovery(lease.mountRef, request, {
            signal,
          }),
          request,
        );
        assertPluginUiCurrent(assertCurrent, signal);
        if (hydrated.get(lease.mountRef) !== checkedLeaseIdentity(lease))
          uiFailure("plugin_ui_recovery_not_ready");
        return ack.intent;
      };
    },
    release(lease: PluginUiLease): void {
      hydrated.delete(lease.mountRef);
    },
  });
}
