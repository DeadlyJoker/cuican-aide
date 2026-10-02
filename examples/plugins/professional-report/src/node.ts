import {
  definePlugin,
  CREWON_TASKS_SERVICE,
  CREWON_TASKS_API_VERSION,
  CREWON_EXECUTION_SERVICE,
  CREWON_EXECUTION_API_VERSION,
  type PluginActionsService,
  type PluginExecutionService,
  type PluginTaskRequest,
  type PluginTaskService,
} from "@crewon/plugin-sdk/node";
import { createReportRuntime } from "./runtime.js";

export default definePlugin({
  apiVersion: "crewon.plugin-host.v1",
  pluginId: "example.professional",
  setup(context) {
    if (typeof context.services.getOptional !== "function")
      throw new Error("professional_plugin_optional_services_unsupported");
    const tasks = context.services.getOptional<PluginTaskService>(
      CREWON_TASKS_SERVICE,
      CREWON_TASKS_API_VERSION,
    );
    const execution = context.services.getOptional<PluginExecutionService>(
      CREWON_EXECUTION_SERVICE,
      CREWON_EXECUTION_API_VERSION,
    );
    if (execution) {
      const registration = execution.register({ create: createReportRuntime });
      context.onDispose(() => registration.dispose());
    }
    const actions: PluginActionsService = {
      actions: [
        {
          contributionId: "studio",
          action: "report.generate",
          kind: "generateTask",
        },
      ],
      async invoke(invocation) {
        if (!tasks) throw new Error("professional_plugin_tasks_unavailable");
        if (
          invocation.contributionId !== "studio" ||
          invocation.action !== "report.generate"
        )
          throw new Error("professional_plugin_action_unavailable");
        const input = invocation.input as unknown as Omit<
          PluginTaskRequest,
          "invocationRef"
        >;
        return tasks.createTask({
          ...input,
          invocationRef: invocation.invocationRef,
        });
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
