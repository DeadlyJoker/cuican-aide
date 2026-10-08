import { isProjectConversationUiNamespaceAction } from "@crewon/contracts/project-conversation-association";
import {
  isProjectAssetStageControlOwner,
  type ProjectAssetStageControlOwner,
} from "./project-asset-stage-control-owner.ts";
import {
  isInstalledPluginProjectHistoricalQueryOwner,
  type InstalledPluginProjectHistoricalQueryOwner,
} from "./installed-plugin-project-historical-query-owner.ts";
import type { ProjectConversationControlOwner } from "./project-conversation-control-owner.ts";
import { randomBytes } from "node:crypto";
import {
  ApplicationError,
  PluginUiApplicationService,
  isPluginUiRecoveryApplicationService,
  type PluginUiRecoveryApplicationService,
  isPluginProjectAssetActionOwner,
  type PluginProjectAssetActionOwner,
  isPluginProjectAssetRecoveryActionOwner,
  type PluginProjectAssetRecoveryActionOwner,
  isPluginProjectTextActionOwner,
  type PluginProjectTextActionOwner,
  isPluginProjectTextRecoveryActionOwner,
  type PluginProjectTextRecoveryActionOwner,
  isPluginProjectTextPlanActionOwner,
  type PluginProjectTextPlanActionOwner,
  isPluginCreativeProjectActionOwner,
  type PluginCreativeProjectActionOwner,
  isPluginProjectSourceUploadActionOwner,
  type PluginProjectSourceUploadActionOwner,
  isPluginProjectFoundationActionOwner,
  type PluginProjectFoundationActionOwner,
  type ApplicationClock,
  type PluginInstallationStore,
  type PluginUiActionPort,
  type PluginUiCommittedTaskPort,
  type PluginUiPackageContext,
  type PluginUiPackagePort,
} from "@crewon/application";
import {
  LocalPluginUiPackageReader,
  isPluginProjectGenerationReadActionBridge,
  type PluginProjectGenerationReadActionBridge,
} from "@crewon/plugin-host";
import type { PluginUiControlService } from "./plugin-control-route.ts";
import {
  AuthorityPluginHostProfile,
  DynamicPluginUiAuthorization,
} from "./plugin-security-adapters.ts";
import {
  HttpPluginProfileAuthorityPort,
  HttpPluginUiPolicyDecisionPort,
} from "./plugin-security-http-ports.ts";
import { AbortSecurityDeadline } from "./production-security-adapters.ts";
import {
  parseProductionPluginUiConfiguration,
  type ProductionPluginUiConfiguration,
} from "./production-plugin-ui-environment.ts";
import {
  isInstalledPluginTaskActionOwner,
  type InstalledPluginTaskActionOwner,
} from "./installed-plugin-task-action-owner.ts";
import {
  isInstalledPluginProjectGenerationOwner,
  type InstalledPluginProjectGenerationOwner,
} from "./installed-plugin-project-generation-owner.ts";
import {
  isInstalledPluginProjectQueryOwner,
  type InstalledPluginProjectQueryOwner,
} from "./installed-plugin-project-query-owner.ts";
import {
  isProjectGenerationSelectionPluginUiOwner,
  combineSelectionCommittedMetadata,
  type ProjectGenerationSelectionPluginUiOwner,
} from "./project-generation-selection-plugin-ui-owner.ts";

export type ProductionPluginUiConfig = Readonly<{
  configuration: ProductionPluginUiConfiguration;
  /** Must enter the existing authorized business/Run boundary; no automatic Node dispatch. */
  actions?: PluginUiActionPort;
  /** Trusted verifier for original durable task receipts; absent for read-only deployments. */
  committedTasks?: PluginUiCommittedTaskPort;
  /** Transfers the actual Node/task resources together with their durable-receipt authority. */
  ownedTaskActions?: InstalledPluginTaskActionOwner;
  /** Actual metadata dispatcher; task receipt ownership remains an independent capability. */
  ownedCreativeProjectActions?: PluginCreativeProjectActionOwner;
  ownedProjectFoundationActions?: PluginProjectFoundationActionOwner;
  ownedProjectSourceUploadActions?: PluginProjectSourceUploadActionOwner;
  ownedProjectConversationActions?: ProjectConversationControlOwner;
  ownedProjectTextPlanActions?: PluginProjectTextPlanActionOwner;
  ownedProjectAssetStageActions?: ProjectAssetStageControlOwner;
  ownedProjectAssetActions?: PluginProjectAssetActionOwner;
  ownedProjectAssetRecoveryActions?: PluginProjectAssetRecoveryActionOwner;
  ownedProjectTextActions?: PluginProjectTextActionOwner;
  ownedProjectTextRecoveryActions?: PluginProjectTextRecoveryActionOwner;
  ownedProjectGenerationActions?: InstalledPluginProjectGenerationOwner;
  ownedProjectGenerationReadActions?: PluginProjectGenerationReadActionBridge;
  ownedProjectQueryActions?: InstalledPluginProjectQueryOwner;
  ownedProjectHistoricalQueryActions?: InstalledPluginProjectHistoricalQueryOwner;
  ownedProjectSelectionActions?: ProjectGenerationSelectionPluginUiOwner;
  recovery?: PluginUiRecoveryApplicationService;
}>;
export type ProductionPluginUiRuntime = Readonly<{
  service: PluginUiControlService;
  close(): Promise<void>;
}>;

/** Stateless scoped readers share installed bytes, never authority, profile selection or leases. */
export function createProductionPluginUiRuntime(
  input: ProductionPluginUiConfig,
  dependencies: Readonly<{
    ledger: PluginInstallationStore;
    clock: ApplicationClock;
    fetch?: typeof globalThis.fetch;
  }>,
): ProductionPluginUiRuntime {
  const configuration = parseProductionPluginUiConfiguration(
    input.configuration,
  );
  const { actions, committedTasks, owner } =
    captureProductionPluginUiActions(input);
  const metadataOwner = input.ownedCreativeProjectActions;
  const foundationOwner = input.ownedProjectFoundationActions;
  const uploadOwner = input.ownedProjectSourceUploadActions;
  if (
    uploadOwner !== undefined &&
    !isPluginProjectSourceUploadActionOwner(uploadOwner)
  )
    throw new Error("production_plugin_ui_source_upload_owner_invalid");
  if (
    foundationOwner !== undefined &&
    !isPluginProjectFoundationActionOwner(foundationOwner)
  )
    throw new Error("production_plugin_ui_foundation_owner_invalid");
  const assetStageOwner = input.ownedProjectAssetStageActions;
  const assetOwner = input.ownedProjectAssetActions;
  const assetRecoveryOwner = input.ownedProjectAssetRecoveryActions;
  const textOwner = input.ownedProjectTextActions;
  const textRecoveryOwner = input.ownedProjectTextRecoveryActions;
  const generationOwner = input.ownedProjectGenerationActions;
  const generationReadOwner = input.ownedProjectGenerationReadActions;
  const queryOwner = input.ownedProjectQueryActions;
  const historicalOwner = input.ownedProjectHistoricalQueryActions;
  if (
    historicalOwner !== undefined &&
    (!isInstalledPluginProjectHistoricalQueryOwner(historicalOwner) ||
      historicalOwner.taskOwner !== owner)
  )
    throw new Error("production_plugin_ui_historical_query_owner_invalid");
  const selectionOwner = input.ownedProjectSelectionActions;
  const recovery = input.recovery;
  if (recovery !== undefined && !isPluginUiRecoveryApplicationService(recovery))
    throw new Error("production_plugin_ui_recovery_owner_invalid");
  if (
    selectionOwner !== undefined &&
    !isProjectGenerationSelectionPluginUiOwner(selectionOwner)
  )
    throw new Error("production_plugin_ui_selection_owner_invalid");
  const originalCommittedMetadata =
    selectionOwner === undefined
      ? metadataOwner?.committedMetadata
      : combineSelectionCommittedMetadata(
          selectionOwner.committedMetadata,
          metadataOwner?.committedMetadata,
        );
  if (textOwner !== undefined && !isPluginProjectTextActionOwner(textOwner))
    throw new Error("production_plugin_ui_text_owner_invalid");
  const textMetadata =
    textOwner === undefined
      ? originalCommittedMetadata
      : combineSelectionCommittedMetadata(
          textOwner.committedMetadata,
          originalCommittedMetadata,
        );
  if (
    textRecoveryOwner !== undefined &&
    !isPluginProjectTextRecoveryActionOwner(textRecoveryOwner)
  )
    throw new Error("production_plugin_ui_text_recovery_owner_invalid");
  const recoveryMetadata =
    textRecoveryOwner === undefined
      ? textMetadata
      : combineSelectionCommittedMetadata(
          textRecoveryOwner.committedMetadata,
          textMetadata,
        );
  const assetMetadata =
    assetOwner === undefined
      ? recoveryMetadata
      : combineSelectionCommittedMetadata(
          assetOwner.committedMetadata,
          recoveryMetadata,
        );
  const assetRecoveryMetadata =
    assetRecoveryOwner === undefined
      ? assetMetadata
      : combineSelectionCommittedMetadata(
          assetRecoveryOwner.committedMetadata,
          assetMetadata,
        );
  const assetStageMetadata =
    assetStageOwner === undefined
      ? assetRecoveryMetadata
      : combineSelectionCommittedMetadata(
          assetStageOwner.committedMetadata,
          assetRecoveryMetadata,
        );
  const conversationOwner = input.ownedProjectConversationActions;
  if (conversationOwner !== undefined) conversationOwner.assertAvailable();
  const conversationMetadata =
    conversationOwner === undefined
      ? assetStageMetadata
      : combineSelectionCommittedMetadata(
          conversationOwner.committedMetadata,
          assetStageMetadata,
        );
  const planOwner = input.ownedProjectTextPlanActions;
  if (planOwner !== undefined && !isPluginProjectTextPlanActionOwner(planOwner))
    throw new Error("production_plugin_ui_plan_owner_invalid");
  const planMetadata =
    planOwner === undefined
      ? conversationMetadata
      : combineSelectionCommittedMetadata(
          planOwner.committedMetadata,
          conversationMetadata,
        );
  const foundationMetadata =
    foundationOwner === undefined
      ? planMetadata
      : combineSelectionCommittedMetadata(
          foundationOwner.committedMetadata,
          planMetadata,
        );
  const committedMetadata =
    uploadOwner === undefined
      ? foundationMetadata
      : combineSelectionCommittedMetadata(
          uploadOwner.committedMetadata,
          foundationMetadata,
        );
  if (
    queryOwner !== undefined &&
    (!isInstalledPluginProjectQueryOwner(queryOwner) ||
      queryOwner.taskOwner !== owner)
  )
    throw new Error("production_plugin_ui_project_query_owner_invalid");
  if (
    generationReadOwner !== undefined &&
    !isPluginProjectGenerationReadActionBridge(generationReadOwner)
  )
    throw new Error("production_plugin_ui_generation_read_owner_invalid");
  if (
    generationOwner !== undefined &&
    (!isInstalledPluginProjectGenerationOwner(generationOwner) ||
      generationOwner.taskOwner !== owner)
  )
    throw new Error("production_plugin_ui_generation_owner_invalid");
  if (
    metadataOwner !== undefined &&
    !isPluginCreativeProjectActionOwner(metadataOwner)
  )
    throw new Error("production_plugin_ui_metadata_owner_invalid");
  if (actions !== undefined && typeof actions?.invoke !== "function")
    throw new Error("production_plugin_ui_actions_invalid");
  const invokeAction = actions?.invoke.bind(actions);
  const readActions = generationReadOwner?.actions({
    invoke: async () => {
      throw new ApplicationError("conflict", "plugin_ui_actions_unavailable");
    },
  });
  if (
    committedTasks !== undefined &&
    (typeof committedTasks.isOutcome !== "function" ||
      typeof committedTasks.verify !== "function")
  )
    throw new Error("production_plugin_ui_committed_tasks_invalid");
  const committedSnapshot =
    committedTasks === undefined
      ? undefined
      : Object.freeze({
          isOutcome: committedTasks.isOutcome.bind(committedTasks),
          verify: committedTasks.verify.bind(committedTasks),
        });
  const lifetime = new AbortController();
  const available = () => {
    if (lifetime.signal.aborted) unavailable();
  };
  const deadline = new AbortSecurityDeadline();
  const scopedDeadline = {
    run: <T>(timeoutMs: number, task: (signal: AbortSignal) => Promise<T>) => {
      available();
      return deadline.run(timeoutMs, (signal) =>
        task(AbortSignal.any([signal, lifetime.signal])),
      );
    },
  };
  const reader = (context: PluginUiPackageContext) => {
    available();
    return new LocalPluginUiPackageReader({
      profile: context.scope,
      installRoot: configuration.installRoot,
      authorizePublication: async ({ package: pkg, descriptor }) => {
        available();
        const approved = configuration.publications.find(
          (item) =>
            item.packageDigest === pkg.packageDigest &&
            item.pluginId === descriptor.pluginId &&
            item.publisherId === descriptor.publisherId,
        );
        if (!approved)
          throw new ApplicationError(
            "authorization",
            "plugin_ui_publication_denied",
          );
        // Local reader validates every approved path against the verified inventory,
        // requires the actual UI entry and repeats this check around asset reads.
        return approved.publicAssets;
      },
    });
  };
  const packages: PluginUiPackagePort = {
    verify: (context) => reader(context).verify(context),
    readAsset: (context) => reader(context).readAsset(context),
  };
  let application: PluginUiApplicationService | null =
    new PluginUiApplicationService({
      store: dependencies.ledger,
      clock: dependencies.clock,
      packages,
      profiles: new AuthorityPluginHostProfile({
        authority: new HttpPluginProfileAuthorityPort({
          ...configuration.profileAuthority,
          fetch: dependencies.fetch,
        }),
        timeoutMs: configuration.timeoutMs,
        deadline: scopedDeadline,
      }),
      authorization: new DynamicPluginUiAuthorization({
        policy: new HttpPluginUiPolicyDecisionPort({
          ...configuration.policyAuthority,
          fetch: dependencies.fetch,
        }),
        timeoutMs: configuration.timeoutMs,
        deadline: scopedDeadline,
      }),
      ids: { nextId: () => randomBytes(32).toString("base64url") },
      actions: {
        invoke: async (request) => {
          available();
          if (
            request.action === "crewon.project-source-uploads" ||
            request.action.startsWith("crewon.project-source-uploads.")
          ) {
            if (
              uploadOwner === undefined ||
              !uploadOwner.supportsAction(request.action)
            )
              throw new ApplicationError(
                "conflict",
                "project_source_upload_unavailable",
              );
            return uploadOwner.actions.invoke(request);
          }
          if (
            request.action === "crewon.project-foundation" ||
            request.action.startsWith("crewon.project-foundation.")
          ) {
            if (
              foundationOwner === undefined ||
              !foundationOwner.supportsAction(request.action)
            )
              throw new ApplicationError(
                "conflict",
                "project_foundation_unavailable",
              );
            return foundationOwner.actions.invoke(request);
          }
          if (
            request.action === "crewon.project-asset-stages" ||
            request.action.startsWith("crewon.project-asset-stages.")
          ) {
            if (
              assetStageOwner === undefined ||
              !assetStageOwner.supportsAction(request.action)
            )
              throw new ApplicationError(
                "conflict",
                "project_asset_stage_unavailable",
              );
            return assetStageOwner.actions.invoke(request);
          }
          if (
            request.action === "crewon.project-assets" ||
            request.action.startsWith("crewon.project-assets.")
          ) {
            if (
              assetOwner === undefined ||
              !assetOwner.supportsAction(request.action)
            )
              throw new ApplicationError(
                "conflict",
                "plugin_ui_actions_unavailable",
              );
            return assetOwner.actions.invoke(request);
          }
          if (
            request.action === "crewon.project-asset-recovery" ||
            request.action.startsWith("crewon.project-asset-recovery.")
          ) {
            if (
              assetRecoveryOwner === undefined ||
              !assetRecoveryOwner.supportsAction(request.action)
            )
              throw new ApplicationError(
                "conflict",
                "plugin_ui_actions_unavailable",
              );
            return assetRecoveryOwner.actions.invoke(request);
          }
          if (
            request.action === "crewon.project-text-plans" ||
            request.action.startsWith("crewon.project-text-plans.")
          ) {
            if (
              planOwner === undefined ||
              !planOwner.supportsAction(request.action)
            )
              throw new ApplicationError(
                "conflict",
                "project_text_plan_unavailable",
              );
            return planOwner.actions.invoke(request);
          }
          if (isProjectConversationUiNamespaceAction(request.action)) {
            if (
              conversationOwner === undefined ||
              !conversationOwner.supportsAction(request.action)
            )
              throw new ApplicationError(
                "conflict",
                "project_conversation_unavailable",
              );
            return conversationOwner.actions.invoke(request);
          }
          if (
            request.action === "crewon.project-text-recovery" ||
            request.action.startsWith("crewon.project-text-recovery.")
          ) {
            if (
              textRecoveryOwner === undefined ||
              !textRecoveryOwner.supportsAction(request.action)
            )
              throw new ApplicationError(
                "conflict",
                "plugin_ui_actions_unavailable",
              );
            return textRecoveryOwner.actions.invoke(request);
          }
          if (
            request.action === "crewon.project-texts" ||
            request.action.startsWith("crewon.project-texts.")
          ) {
            if (
              textOwner === undefined ||
              !textOwner.supportsAction(request.action)
            )
              throw new ApplicationError(
                "conflict",
                "plugin_ui_actions_unavailable",
              );
            return textOwner.actions.invoke(request);
          }
          if (
            request.action === "crewon.project-generation-selections" ||
            request.action.startsWith("crewon.project-generation-selections.")
          ) {
            if (selectionOwner === undefined)
              throw new ApplicationError(
                "conflict",
                "plugin_ui_actions_unavailable",
              );
            return selectionOwner.actions.invoke(request);
          }
          if (
            request.action === "crewon.project-historical-queries" ||
            request.action.startsWith("crewon.project-historical-queries.")
          ) {
            if (historicalOwner === undefined)
              throw new ApplicationError(
                "conflict",
                "plugin_ui_actions_unavailable",
              );
            return historicalOwner.actions.invoke(request);
          }
          if (
            request.action === "crewon.project-generation-queries" ||
            request.action.startsWith("crewon.project-generation-queries.")
          ) {
            if (queryOwner === undefined)
              throw new ApplicationError(
                "conflict",
                "plugin_ui_actions_unavailable",
              );
            return queryOwner.actions.invoke(request);
          }
          if (
            request.action === "crewon.project-generation-reads" ||
            request.action.startsWith("crewon.project-generation-reads.")
          ) {
            if (generationReadOwner === undefined)
              throw new ApplicationError(
                "conflict",
                "plugin_ui_actions_unavailable",
              );
            return readActions!.invoke(request);
          }
          if (metadataOwner?.supportsAction(request.action))
            return metadataOwner.actions.invoke(request);
          if (
            request.action === "crewon.project-generation-contexts" ||
            request.action.startsWith("crewon.project-generation-contexts.") ||
            request.action.startsWith("crewon.project-generations.")
          ) {
            if (generationOwner === undefined)
              throw new ApplicationError(
                "conflict",
                "plugin_ui_actions_unavailable",
              );
            return generationOwner.actions.invoke(request);
          }
          if (invokeAction === undefined)
            throw new ApplicationError(
              "conflict",
              "plugin_ui_actions_unavailable",
            );
          return invokeAction(request);
        },
      },
      ...(committedSnapshot === undefined
        ? {}
        : { committedTasks: committedSnapshot }),
      ...(committedMetadata === undefined ? {} : { committedMetadata }),
      ...(recovery === undefined ? {} : { recovery }),
      ...(uploadOwner === undefined ? {} : { sourceUploads: uploadOwner }),
    });
  const call = async <T>(
    work: (service: PluginUiApplicationService) => Promise<T>,
  ): Promise<T> => {
    available();
    const current = application;
    if (current === null) unavailable();
    return new Promise<T>((resolve, reject) => {
      const abort = () =>
        reject(
          new ApplicationError("conflict", "plugin_ui_service_unavailable"),
        );
      lifetime.signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          available();
          return work(current);
        })
        .then((result) => {
          available();
          resolve(result);
        })
        .catch(reject)
        .finally(() => lifetime.signal.removeEventListener("abort", abort));
      if (lifetime.signal.aborted) abort();
    });
  };
  const service: PluginUiControlService = Object.freeze({
    catalog: (...args) => call((current) => current.catalog(...args)),
    openMount: (...args) => call((current) => current.openMount(...args)),
    validateMount: (...args) =>
      call((current) => current.validateMount(...args)),
    renewMount: (...args) => call((current) => current.renewMount(...args)),
    readAsset: (...args) => call((current) => current.readAsset(...args)),
    closeMount: (...args) => call((current) => current.closeMount(...args)),
    invoke: (...args) => {
      if (committedSnapshot === undefined && committedMetadata === undefined)
        return call((current) => current.invoke(...args));
      available();
      const current = application;
      if (current === null) unavailable();
      // The application returns late success only for a verified durable receipt. JSON results
      // still run its policy fence, whose requests are cancelled by this runtime's lifetime.
      return current.invoke(...args);
    },
    ...(uploadOwner === undefined
      ? {}
      : {
          invokeProjectSourceUploadPart: (
            ...args: Parameters<
              PluginUiApplicationService["invokeProjectSourceUploadPart"]
            >
          ) => {
            available();
            const current = application;
            if (current === null) unavailable();
            return current.invokeProjectSourceUploadPart(...args);
          },
        }),
    ...(recovery === undefined
      ? {}
      : {
          getRecovery: (
            ...args: Parameters<PluginUiApplicationService["getRecovery"]>
          ) => call((current) => current.getRecovery(...args)),
          stageRecovery: (
            ...args: Parameters<PluginUiApplicationService["stageRecovery"]>
          ) => call((current) => current.stageRecovery(...args)),
        }),
  });
  let closing: Promise<void> | null = null;
  return Object.freeze({
    service,
    close: () => {
      lifetime.abort();
      application = null;
      return (closing ??= Promise.allSettled([
        generationOwner?.close(),
        historicalOwner?.close(),
        queryOwner?.close(),
        generationReadOwner?.close(),
        owner?.close(),
        metadataOwner?.close(),
        foundationOwner?.close(),
        uploadOwner?.close(),
        assetStageOwner?.close(),
        assetOwner?.close(),
        assetRecoveryOwner?.close(),
        textOwner?.close(),
        textRecoveryOwner?.close(),
        selectionOwner?.close(),
        planOwner?.close(),
      ]).then((results) => {
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(
            failures,
            "production_plugin_ui_cleanup_failed",
          );
      }));
    },
  });
}

/** Capture an actual owner as a pair; a structural DTO never transfers Node ownership. */
export function captureProductionPluginUiActions(
  input: ProductionPluginUiConfig,
): Readonly<{
  actions: PluginUiActionPort | undefined;
  committedTasks: PluginUiCommittedTaskPort | undefined;
  owner: InstalledPluginTaskActionOwner | undefined;
}> {
  const sourceUpload = Object.getOwnPropertyDescriptor(
    input,
    "ownedProjectSourceUploadActions",
  );
  if (
    (sourceUpload !== undefined &&
      (!sourceUpload.enumerable || !Object.hasOwn(sourceUpload, "value"))) ||
    (sourceUpload === undefined &&
      "ownedProjectSourceUploadActions" in input) ||
    (sourceUpload?.value !== undefined &&
      !isPluginProjectSourceUploadActionOwner(sourceUpload.value))
  )
    throw new Error("production_plugin_ui_source_upload_owner_invalid");
  const foundation = Object.getOwnPropertyDescriptor(
    input,
    "ownedProjectFoundationActions",
  );
  if (
    (foundation !== undefined &&
      (!foundation.enumerable || !Object.hasOwn(foundation, "value"))) ||
    (foundation === undefined && "ownedProjectFoundationActions" in input) ||
    (foundation?.value !== undefined &&
      !isPluginProjectFoundationActionOwner(foundation.value))
  )
    throw new Error("production_plugin_ui_foundation_owner_invalid");
  for (const field of [
    "ownedProjectAssetActions",
    "ownedProjectAssetRecoveryActions",
    "ownedProjectAssetStageActions",
  ] as const) {
    const value = Object.getOwnPropertyDescriptor(input, field);
    if (
      (value !== undefined &&
        (!value.enumerable || !Object.hasOwn(value, "value"))) ||
      (value === undefined && field in input)
    )
      throw new Error("production_plugin_ui_asset_owner_invalid");
  }
  if (
    input.ownedProjectAssetStageActions !== undefined &&
    !isProjectAssetStageControlOwner(input.ownedProjectAssetStageActions)
  )
    throw new Error("production_plugin_ui_asset_stage_owner_invalid");
  if (
    input.ownedProjectAssetActions !== undefined &&
    !isPluginProjectAssetActionOwner(input.ownedProjectAssetActions)
  )
    throw new Error("production_plugin_ui_asset_owner_invalid");
  if (
    input.ownedProjectAssetRecoveryActions !== undefined &&
    !isPluginProjectAssetRecoveryActionOwner(
      input.ownedProjectAssetRecoveryActions,
    )
  )
    throw new Error("production_plugin_ui_asset_recovery_owner_invalid");
  if (
    input.ownedProjectTextRecoveryActions !== undefined &&
    !isPluginProjectTextRecoveryActionOwner(
      input.ownedProjectTextRecoveryActions,
    )
  )
    throw new Error("production_plugin_ui_text_recovery_owner_invalid");
  if (
    input.ownedProjectTextActions !== undefined &&
    !isPluginProjectTextActionOwner(input.ownedProjectTextActions)
  )
    throw new Error("production_plugin_ui_text_owner_invalid");
  if (
    input.ownedProjectSelectionActions !== undefined &&
    !isProjectGenerationSelectionPluginUiOwner(
      input.ownedProjectSelectionActions,
    )
  )
    throw new Error("production_plugin_ui_selection_owner_invalid");
  if (
    input.ownedProjectGenerationReadActions !== undefined &&
    !isPluginProjectGenerationReadActionBridge(
      input.ownedProjectGenerationReadActions,
    )
  )
    throw new Error("production_plugin_ui_generation_read_owner_invalid");
  if (
    input.ownedCreativeProjectActions !== undefined &&
    !isPluginCreativeProjectActionOwner(input.ownedCreativeProjectActions)
  )
    throw new Error("production_plugin_ui_metadata_owner_invalid");
  const owner = input.ownedTaskActions;
  if (
    input.ownedProjectHistoricalQueryActions !== undefined &&
    (!isInstalledPluginProjectHistoricalQueryOwner(
      input.ownedProjectHistoricalQueryActions,
    ) ||
      input.ownedProjectHistoricalQueryActions.taskOwner !== owner)
  )
    throw new Error("production_plugin_ui_historical_query_owner_invalid");
  if (
    input.ownedProjectQueryActions !== undefined &&
    (!isInstalledPluginProjectQueryOwner(input.ownedProjectQueryActions) ||
      input.ownedProjectQueryActions.taskOwner !== owner)
  )
    throw new Error("production_plugin_ui_project_query_owner_invalid");
  if (
    input.ownedProjectGenerationActions !== undefined &&
    (!isInstalledPluginProjectGenerationOwner(
      input.ownedProjectGenerationActions,
    ) ||
      input.ownedProjectGenerationActions.taskOwner !== owner)
  )
    throw new Error("production_plugin_ui_generation_owner_invalid");
  if (owner !== undefined) {
    if (!isInstalledPluginTaskActionOwner(owner))
      throw new Error("production_plugin_ui_action_owner_invalid");
    if (input.actions !== undefined || input.committedTasks !== undefined)
      throw new Error("production_plugin_ui_action_owner_conflict");
    return Object.freeze({
      actions: owner.actions,
      committedTasks: owner.committedTasks,
      owner,
    });
  }
  return Object.freeze({
    actions: input.actions,
    committedTasks: input.committedTasks,
    owner: undefined,
  });
}
function unavailable(): never {
  throw new ApplicationError("conflict", "plugin_ui_service_unavailable");
}
