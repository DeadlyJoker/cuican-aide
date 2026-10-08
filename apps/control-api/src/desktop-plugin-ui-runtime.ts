import {
  ApplicationError,
  PluginUiApplicationService,
} from "@crewon/application";
import { isProjectMediaGenerationUiNamespaceAction } from "@crewon/contracts/project-media-generations";
import { isProjectMediaResultUiNamespaceAction } from "@crewon/contracts/project-media-results-ui";
import { isProjectMediaInputUiNamespaceAction } from "@crewon/contracts/project-media-inputs-ui";
import { isProjectAssetUiNamespaceAction } from "@crewon/contracts/project-assets";
import { isProjectAssetRecoveryNamespaceAction } from "@crewon/contracts/project-asset-recovery";
import { isProjectAssetStagesNamespaceAction } from "@crewon/contracts/project-asset-stages";
import { isProjectConversationUiNamespaceAction } from "@crewon/contracts/project-conversation-association";
import type { PluginUiControlService } from "./plugin-control-route.ts";
import type { CreativeProjectPluginUiRuntime } from "./creative-project-plugin-ui-composition.ts";
import type { ProjectTextPluginUiRuntime } from "./project-text-plugin-ui-composition.ts";
import type { ProjectAssetPluginUiRuntime } from "./project-asset-plugin-ui-composition.ts";
import type { DesktopProjectHistoryPluginRuntime } from "./desktop-project-history-plugin-runtime.ts";
import type { DesktopPluginConfigurationRuntime } from "./desktop-plugin-configuration-runtime.ts";
import type { DesktopPluginUiRecoveryRuntime } from "./desktop-plugin-ui-recovery.ts";
import type { DesktopInstalledPluginTaskRuntime } from "./desktop-installed-plugin-task-runtime.ts";
import type { DesktopNativePluginTaskRuntime } from "./desktop-native-plugin-task-runtime.ts";
import type { composeDesktopProjectMediaGenerationUi } from "./desktop-project-media-generation-ui-composition.ts";
import type { composeDesktopProjectMediaResultUi } from "./desktop-project-media-result-ui-composition.ts";
import type { composeDesktopProjectMediaInputUi } from "./desktop-project-media-input-ui-composition.ts";
import type { createDesktopProjectConversationRuntime } from "./desktop-project-conversation-runtime.ts";
import type { createDesktopProjectFoundationPluginRuntime } from "./desktop-project-foundation-plugin-runtime.ts";

/** Reuses the original Native lifetime checks and owners. No policy, Run or mount identity is manufactured here. */
export function createDesktopPluginUiControlRuntime(
  input: Readonly<{
    application: PluginUiApplicationService;
    available(): void;
    physical: Set<Promise<unknown>>;
    projectUi: CreativeProjectPluginUiRuntime | undefined;
    textUi: ProjectTextPluginUiRuntime | undefined;
    assetUi: ProjectAssetPluginUiRuntime | undefined;
    history: DesktopProjectHistoryPluginRuntime | undefined;
    configurationRuntime: DesktopPluginConfigurationRuntime;
    recovery: DesktopPluginUiRecoveryRuntime | undefined;
    taskRuntime:
      | DesktopInstalledPluginTaskRuntime
      | DesktopNativePluginTaskRuntime
      | undefined;
    mediaGenerationUi: ReturnType<
      typeof composeDesktopProjectMediaGenerationUi
    >;
    mediaResultUi: ReturnType<typeof composeDesktopProjectMediaResultUi>;
    mediaInputUi: ReturnType<typeof composeDesktopProjectMediaInputUi>;
    conversations: ReturnType<typeof createDesktopProjectConversationRuntime>;
    foundationUi: ReturnType<
      typeof createDesktopProjectFoundationPluginRuntime
    >;
  }>,
): PluginUiControlService {
  const {
    application,
    available,
    physical,
    projectUi,
    textUi,
    assetUi,
    history,
    configurationRuntime,
    recovery,
    taskRuntime,
    mediaGenerationUi,
    mediaResultUi,
    mediaInputUi,
    conversations,
    foundationUi,
  } = input;
  const call = <T>(work: () => Promise<T>): Promise<T> => {
    available();
    const result = Promise.resolve()
      .then(() => {
        available();
        return work();
      })
      .then((value) => {
        available();
        return value;
      });
    physical.add(result);
    void result.finally(() => physical.delete(result)).catch(() => {});
    return result;
  };
  const ui: PluginUiControlService = Object.freeze({
    catalog: (...args) => call(() => application.catalog(...args)),
    openMount: (...args) => call(() => application.openMount(...args)),
    validateMount: (...args) => call(() => application.validateMount(...args)),
    renewMount: (...args) => call(() => application.renewMount(...args)),
    readAsset: (...args) => call(() => application.readAsset(...args)),
    closeMount: (...args) => call(() => application.closeMount(...args)),
    ...(recovery === undefined
      ? {}
      : {
          getRecovery: (
            ...args: Parameters<PluginUiApplicationService["getRecovery"]>
          ) => call(() => application.getRecovery(...args)),
          stageRecovery: (
            ...args: Parameters<PluginUiApplicationService["stageRecovery"]>
          ) => call(() => application.stageRecovery(...args)),
          recoveryAuthenticatedRequest: recovery.run,
        }),
    ...(foundationUi?.uploads === undefined
      ? {}
      : {
          invokeProjectSourceUploadPart: (
            ...args: Parameters<
              PluginUiApplicationService["invokeProjectSourceUploadPart"]
            >
          ) => {
            available();
            // Enter synchronously so the Application snapshots caller bytes before its first await.
            const result = application.invokeProjectSourceUploadPart(...args);
            physical.add(result);
            void result.finally(() => physical.delete(result)).catch(() => {});
            return result;
          },
        }),
    invoke: (...args) => {
      if (
        foundationUi === undefined &&
        projectUi === undefined &&
        conversations === undefined &&
        textUi === undefined &&
        assetUi === undefined &&
        history?.selectionRuntime === undefined &&
        taskRuntime === undefined
      )
        return call(() => application.invoke(...args));
      available();
      // Only Application's genuine committed outcomes can bypass the late current fence.
      const result = application.invoke(...args);
      physical.add(result);
      void result.finally(() => physical.delete(result)).catch(() => {});
      return result;
    },
    ...(foundationUi === undefined &&
    textUi === undefined &&
    assetUi === undefined &&
    conversations === undefined &&
    history?.readRuntime === undefined &&
    history?.selectionRuntime === undefined &&
    recovery === undefined &&
    taskRuntime === undefined
      ? {}
      : {
          invokeAuthenticatedRequest: ((request, actor, command, signal) => {
            available();
            const invoke = () => ui.invoke(actor, command);
            const dispatch = (requestSignal: AbortSignal | undefined) => {
              if (
                command.action === "crewon.project-foundation" ||
                command.action.startsWith("crewon.project-foundation.") ||
                command.action === "crewon.project-source-uploads" ||
                command.action.startsWith("crewon.project-source-uploads.")
              )
                return invoke();
              if (isProjectMediaGenerationUiNamespaceAction(command.action)) {
                if (
                  mediaGenerationUi === undefined ||
                  taskRuntime === undefined
                )
                  throw new ApplicationError(
                    "conflict",
                    "project_media_generation_ui_unavailable",
                  );
                return taskRuntime.core.requests.run(
                  { request, actor, signal: requestSignal },
                  invoke,
                );
              }
              if (isProjectMediaResultUiNamespaceAction(command.action)) {
                if (mediaResultUi === undefined || taskRuntime === undefined)
                  throw new ApplicationError(
                    "conflict",
                    "project_media_result_ui_unavailable",
                  );
                return taskRuntime.core.requests.run(
                  {
                    request,
                    actor,
                    signal: requestSignal,
                    preparation: "configuration",
                  },
                  invoke,
                );
              }
              if (isProjectMediaInputUiNamespaceAction(command.action)) {
                if (mediaInputUi === undefined || taskRuntime === undefined)
                  throw new ApplicationError(
                    "conflict",
                    "project_media_input_ui_unavailable",
                  );
                return taskRuntime.core.requests.run(
                  {
                    request,
                    actor,
                    signal: requestSignal,
                    preparation: "configuration",
                  },
                  invoke,
                );
              }
              if (
                isProjectAssetUiNamespaceAction(command.action) ||
                isProjectAssetRecoveryNamespaceAction(command.action)
              )
                return invoke();
              if (isProjectAssetStagesNamespaceAction(command.action)) {
                const owner = conversations?.assetStages();
                if (owner === undefined)
                  throw new ApplicationError(
                    "conflict",
                    "project_asset_stage_unavailable",
                  );
                return owner.runAuthenticatedRequest(
                  request,
                  actor,
                  command.action,
                  requestSignal,
                  invoke,
                );
              }
              if (
                command.action === "crewon.project-text-plans" ||
                command.action.startsWith("crewon.project-text-plans.")
              ) {
                const plans = conversations?.textPlans();
                if (plans === undefined)
                  throw new ApplicationError(
                    "conflict",
                    "project_text_plan_unavailable",
                  );
                return plans.invokeAuthenticatedRequest(
                  request,
                  actor,
                  command,
                  requestSignal,
                  invoke,
                );
              }
              if (isProjectConversationUiNamespaceAction(command.action)) {
                const owner = conversations?.owner();
                if (owner === undefined)
                  throw new ApplicationError(
                    "conflict",
                    "plugin_ui_actions_unavailable",
                  );
                return owner.runAuthenticatedRequest(
                  request,
                  actor,
                  command.action,
                  requestSignal,
                  invoke,
                );
              }
              if (
                command.action === "crewon.project-texts" ||
                command.action.startsWith("crewon.project-texts.") ||
                command.action === "crewon.project-text-recovery" ||
                command.action.startsWith("crewon.project-text-recovery.")
              )
                return invoke();
              if (projectUi?.owner.supportsAction(command.action))
                return invoke();
              if (
                command.action === "crewon.project-generations" ||
                command.action.startsWith("crewon.project-generations.") ||
                command.action === "crewon.project-generation-contexts" ||
                command.action.startsWith(
                  "crewon.project-generation-contexts.",
                ) ||
                command.action === "crewon.project-generation-queries" ||
                command.action.startsWith("crewon.project-generation-queries.")
              ) {
                if (taskRuntime === undefined)
                  throw new ApplicationError(
                    "conflict",
                    "plugin_ui_actions_unavailable",
                  );
                return taskRuntime.core.requests.run(
                  { request, actor, signal: requestSignal },
                  invoke,
                );
              }
              if (
                command.action === "crewon.project-generation-reads" ||
                command.action.startsWith("crewon.project-generation-reads.")
              ) {
                if (history?.readRuntime === undefined)
                  throw new ApplicationError(
                    "conflict",
                    "plugin_ui_actions_unavailable",
                  );
                return history.readRuntime.invokeAuthenticatedRequest(
                  request,
                  actor,
                  command,
                  requestSignal,
                  invoke,
                );
              }
              if (
                command.action === "crewon.project-generation-selections" ||
                command.action.startsWith(
                  "crewon.project-generation-selections.",
                )
              ) {
                if (history?.selectionRuntime === undefined)
                  throw new ApplicationError(
                    "conflict",
                    "plugin_ui_actions_unavailable",
                  );
                return history.selectionRuntime.invokeAuthenticatedRequest(
                  request,
                  actor,
                  command,
                  requestSignal,
                  invoke,
                );
              }
              if (taskRuntime !== undefined)
                return taskRuntime.core.requests.run(
                  { request, actor, signal: requestSignal },
                  invoke,
                );
              return invoke();
            };
            // Recovery owns the enclosing lifetime. The business request must remain
            // innermost so its prepared execution state is not shadowed by metadata.
            return recovery === undefined
              ? dispatch(signal)
              : recovery.run(request, actor, signal, () =>
                  dispatch(configurationRuntime!.requests.currentSignal()),
                );
          }) satisfies NonNullable<
            PluginUiControlService["invokeAuthenticatedRequest"]
          >,
        }),
  });
  return ui;
}

export async function closeDesktopPluginRuntimeOwners(
  actions: readonly (() => Promise<unknown> | undefined)[],
): Promise<void> {
  const results = await Promise.allSettled(
    actions.map((action) => {
      try {
        return Promise.resolve(action());
      } catch (error) {
        return Promise.reject(error);
      }
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(failures, "desktop_plugin_runtime_cleanup_failed");
}
