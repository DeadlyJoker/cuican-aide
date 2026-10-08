import { isProjectAssetRecoveryV2Action } from "@crewon/contracts/project-asset-recovery-v2";
import { PROJECT_MEDIA_RESULT_WRITE_ACTIONS } from "@crewon/contracts/project-media-results-ui";
import { registerPluginProjectMediaResultInvocation } from "./plugin-project-media-result-invocation.ts";
import { PROJECT_MEDIA_INPUT_UI_ACTIONS } from "@crewon/contracts/project-media-inputs-ui";
import { PROJECT_MEDIA_GENERATE_UI_ACTION } from "@crewon/contracts/project-media-generations";
import { registerPluginProjectMediaInputInvocation } from "./plugin-project-media-input-invocation.ts";
import { isProjectAssetRecoveryAction } from "@crewon/contracts/project-asset-recovery";
import { registerPluginProjectAssetRecoveryInvocation } from "./plugin-project-asset-recovery-invocation.ts";
import { registerPluginHistoricalQueryInvocation } from "./plugin-project-historical-query-invocation.ts";
import { registerPluginProjectAssetInvocation } from "./plugin-project-asset-invocation.ts";
import { isProjectAssetUiAction } from "@crewon/contracts/project-assets";
import { isProjectAssetV2Action } from "@crewon/contracts/project-assets-v2";
import { registerPluginProjectAssetV2Invocation } from "./plugin-project-asset-v2-invocation.ts";
import { isProjectTextUiMutationAction } from "@crewon/contracts/project-texts-ui";
import { isProjectTextRecoveryAction } from "@crewon/contracts/project-text-recovery";
import { isProjectTextPlanAction } from "./plugin-project-text-plan-action-context.ts";
import { registerPluginUiInvocation } from "./plugin-ui-invocation-authority.ts";
import { isProjectFoundationUiAction } from "@crewon/contracts/project-foundation";
import { registerPluginProjectFoundationInvocation } from "./plugin-project-foundation-invocation.ts";
import { isProjectSourceUploadAction } from "@crewon/contracts/project-source-uploads";
import { registerPluginProjectSourceUploadInvocation } from "./plugin-project-source-upload-invocation.ts";
import type { PluginUiActionContext } from "./plugin-ui-ports.ts";
/** One actual invoke lifecycle. A failed specialized registration releases every acquired membership. */
export function registerPluginUiActionInvocation(
  context: PluginUiActionContext,
  checks: Readonly<{
    assertCurrent(): Promise<void>;
    assertTransactionCurrent(): Promise<void>;
    assertActive(): void;
    usesRecovery: boolean;
  }>,
): () => void {
  const unregister = registerPluginUiInvocation(
    context,
    checks.assertCurrent,
    checks.assertActive,
    context.action.startsWith("crewon.creative-projects.") ||
      context.action === PROJECT_MEDIA_GENERATE_UI_ACTION ||
      checks.usesRecovery ||
      context.action ===
        "crewon.project-generation-selections.v1.selectConceptImage"
      ? Object.freeze({
          assertCurrent: checks.assertTransactionCurrent,
        })
      : undefined,
    isProjectTextUiMutationAction(context.action)
      ? Object.freeze({
          assertCurrent: checks.assertTransactionCurrent,
        })
      : undefined,
    isProjectTextRecoveryAction(context.action)
      ? Object.freeze({
          assertCurrent: checks.assertTransactionCurrent,
        })
      : undefined,
    isProjectTextPlanAction(context.action)
      ? Object.freeze({
          assertCurrent: checks.assertTransactionCurrent,
        })
      : undefined,
  );
  let unregisterHistorical: (() => void) | undefined;
  let unregisterAsset: (() => void) | undefined;
  let unregisterAssetV2: (() => void) | undefined;
  let unregisterAssetRecovery: (() => void) | undefined;
  let unregisterMediaResults: (() => void) | undefined;
  let unregisterMediaInputs: (() => void) | undefined;
  let unregisterFoundation: (() => void) | undefined;
  let unregisterSourceUpload: (() => void) | undefined;
  try {
    unregisterSourceUpload = isProjectSourceUploadAction(context.action)
      ? registerPluginProjectSourceUploadInvocation(
          context,
          checks.assertTransactionCurrent,
        )
      : undefined;
    unregisterFoundation = isProjectFoundationUiAction(context.action)
      ? registerPluginProjectFoundationInvocation(
          context,
          checks.assertTransactionCurrent,
        )
      : undefined;
    unregisterAssetV2 =
      isProjectAssetV2Action(context.action) ||
      isProjectAssetRecoveryV2Action(context.action)
        ? registerPluginProjectAssetV2Invocation(
            context,
            checks.assertTransactionCurrent,
          )
        : undefined;
    unregisterMediaResults =
      context.action === PROJECT_MEDIA_RESULT_WRITE_ACTIONS.saveCandidate
        ? registerPluginProjectMediaResultInvocation(
            context,
            checks.assertTransactionCurrent,
          )
        : undefined;
    unregisterMediaInputs = Object.values(PROJECT_MEDIA_INPUT_UI_ACTIONS).some(
      (a) => a === context.action,
    )
      ? registerPluginProjectMediaInputInvocation(
          context,
          checks.assertTransactionCurrent,
        )
      : undefined;
    unregisterAssetRecovery = isProjectAssetRecoveryAction(context.action)
      ? registerPluginProjectAssetRecoveryInvocation(
          context,
          checks.assertCurrent,
          checks.assertTransactionCurrent,
          checks.assertActive,
        )
      : undefined;
    unregisterAsset = isProjectAssetUiAction(context.action)
      ? registerPluginProjectAssetInvocation(
          context,
          checks.assertCurrent,
          checks.assertTransactionCurrent,
          checks.assertActive,
        )
      : undefined;
    unregisterHistorical =
      context.action ===
      "crewon.project-historical-queries.v1.queryConceptGeneration"
        ? registerPluginHistoricalQueryInvocation(
            context,
            checks.assertCurrent,
            checks.assertTransactionCurrent,
            checks.assertActive,
          )
        : undefined;
    return withdraw;
  } catch (error) {
    withdraw();
    throw error;
  }
  function withdraw() {
    unregisterSourceUpload?.();
    unregisterFoundation?.();
    unregisterHistorical?.();
    unregisterAsset?.();
    unregisterAssetV2?.();
    unregisterMediaInputs?.();
    unregisterMediaResults?.();
    unregisterAssetRecovery?.();
    unregister();
  }
}
