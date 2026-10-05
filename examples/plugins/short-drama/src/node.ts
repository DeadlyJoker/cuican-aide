import {
  definePlugin,
  CREWON_TASKS_SERVICE,
  CREWON_TASKS_V2_API_VERSION,
  CREWON_EXECUTION_SERVICE,
  CREWON_EXECUTION_API_VERSION,
  type PluginActionsService,
  type PluginExecutionService,
  type PluginQueryTaskRequest,
  type PluginTaskRequest,
  type PluginTaskServiceV2,
} from "@crewon/plugin-sdk/node";
import { createShortDramaRuntime } from "./project-tools-runtime.js";
import {
  CREWON_PROJECT_TOOLS_SERVICE,
  CREWON_PROJECT_TOOLS_API_VERSION,
  type PluginProjectToolsService,
} from "./project-tools-service.js";
import {
  CREWON_PROJECT_CONTEXT_SERVICE,
  CREWON_PROJECT_CONTEXT_API_VERSION,
  type PluginProjectContextService,
} from "./project-context-service.js";

import {
  CREWON_PROJECT_ASSET_TOOLS_SERVICE,
  CREWON_PROJECT_ASSET_CONTEXT_SERVICE,
  CREWON_PROJECT_ASSET_TOOLS_API_VERSION,
  type PluginProjectAssetToolsService,
  type PluginProjectAssetContextService,
} from "./project-asset-tools-service.js";

export default definePlugin({
  apiVersion: "crewon.plugin-host.v1",
  pluginId: "crewon.short-drama",
  setup(context) {
    if (typeof context.services.getOptional !== "function")
      throw new Error("krea_plugin_optional_services_unsupported");
    const tasks = context.services.getOptional<PluginTaskServiceV2>(
      CREWON_TASKS_SERVICE,
      CREWON_TASKS_V2_API_VERSION,
    );
    const execution = context.services.getOptional<PluginExecutionService>(
      CREWON_EXECUTION_SERVICE,
      CREWON_EXECUTION_API_VERSION,
    );
    const projects = context.services.getOptional<PluginProjectToolsService>(
      CREWON_PROJECT_TOOLS_SERVICE,
      CREWON_PROJECT_TOOLS_API_VERSION,
    );
    const projectContext =
      context.services.getOptional<PluginProjectContextService>(
        CREWON_PROJECT_CONTEXT_SERVICE,
        CREWON_PROJECT_CONTEXT_API_VERSION,
      );
    const assets = context.services.getOptional<PluginProjectAssetToolsService>(
      CREWON_PROJECT_ASSET_TOOLS_SERVICE,
      CREWON_PROJECT_ASSET_TOOLS_API_VERSION,
    );
    const assetContext =
      context.services.getOptional<PluginProjectAssetContextService>(
        CREWON_PROJECT_ASSET_CONTEXT_SERVICE,
        CREWON_PROJECT_ASSET_TOOLS_API_VERSION,
      );
    if (execution) {
      const registration = execution.register({
        create: (runtimeContext, services) =>
          createShortDramaRuntime(runtimeContext, projects ?? null, services, {
            projectContext: projectContext ?? null,
            assets: assets ?? null,
            assetContext: assetContext ?? null,
          }),
      });
      context.onDispose(() => registration.dispose());
    }
    const actions: PluginActionsService = {
      actions: [
        {
          contributionId: "workbench",
          action: "project.execute",
          kind: "generateTask",
        },
        {
          contributionId: "workbench",
          action: "image.generate",
          kind: "generateTask",
        },
        {
          contributionId: "workbench",
          action: "image.query",
          kind: "queryTask",
        },
      ],
      async invoke(invocation) {
        if (!tasks) throw new Error("krea_plugin_tasks_unavailable");
        if (invocation.contributionId !== "workbench")
          throw new Error("krea_plugin_action_unavailable");
        const input = invocation.input;
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new Error("krea_plugin_action_input_invalid");
        if (
          invocation.action === "image.generate" ||
          invocation.action === "project.execute"
        ) {
          exact(input, [
            "threadId",
            "expectedThreadRevision",
            "idempotencyKey",
            "input",
          ]);
          return tasks.createTask({
            ...(input as unknown as Omit<PluginTaskRequest, "invocationRef">),
            invocationRef: invocation.invocationRef,
          });
        }
        if (invocation.action === "image.query") {
          exact(input, [
            "threadId",
            "expectedThreadRevision",
            "idempotencyKey",
            "sourceRunId",
            "operationId",
          ]);
          return tasks.queryTask({
            ...(input as unknown as Omit<
              PluginQueryTaskRequest,
              "invocationRef"
            >),
            invocationRef: invocation.invocationRef,
          });
        }
        throw new Error("krea_plugin_action_unavailable");
      },
    };
    const registration = context.services.provide(
      context.identity.pluginId,
      "1",
      actions,
    );
    context.onDispose(() => registration.dispose());
  },
});

function exact(value: object, keys: readonly string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("krea_plugin_action_input_invalid");
}
