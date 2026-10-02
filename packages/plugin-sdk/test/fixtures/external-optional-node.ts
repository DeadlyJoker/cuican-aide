import {
  definePlugin,
  CREWON_TASKS_SERVICE,
  CREWON_TASKS_API_VERSION,
  CREWON_EXECUTION_SERVICE,
  CREWON_EXECUTION_API_VERSION,
  type PluginNodeServices,
  type PluginTaskService,
  type PluginExecutionService,
  type PluginActionsService,
  type PluginToolRuntime,
  type PluginToolRuntimeFactory,
} from "@crewon/plugin-sdk/node";

// Existing host contexts remain structurally compatible with the distributed SDK.
export const legacyServices: PluginNodeServices = {
  get() {
    throw new Error("legacy-fixture-service-unavailable");
  },
  provide() {
    return { dispose() {} };
  },
};

/** ABI fixture only; this factory does not call a supplier or create a Run. */
const factory: PluginToolRuntimeFactory = {
  create() {
    const runtime: PluginToolRuntime = {
      definitions: () => [],
      executionPolicy: () => null,
      execute: async (command) => ({
        status: "unknownOutcome",
        executionId: command.executionId,
        providerReceiptId: null,
      }),
      reconcile: async (command) => ({
        status: "unknownOutcome",
        executionId: command.executionId,
        providerReceiptId: null,
      }),
      cancel: async (command) => ({
        status: "unknownOutcome",
        executionId: command.executionId,
        providerReceiptId: null,
      }),
    };
    return runtime;
  },
};

export default definePlugin({
  apiVersion: "crewon.plugin-host.v1",
  pluginId: "example.optional",
  setup(context) {
    if (typeof context.services.getOptional !== "function")
      throw new Error("plugin_optional_service_api_unavailable");
    const tasks = context.services.getOptional<PluginTaskService>(
      CREWON_TASKS_SERVICE,
      CREWON_TASKS_API_VERSION,
    );
    const execution = context.services.getOptional<PluginExecutionService>(
      CREWON_EXECUTION_SERVICE,
      CREWON_EXECUTION_API_VERSION,
    );
    if (execution !== undefined) {
      const registration = execution.register(factory);
      context.onDispose(() => registration.dispose());
    }
    // The descriptor's action service is provided even in the execution-only context.
    const actions: PluginActionsService = {
      actions:
        tasks === undefined
          ? []
          : [
              {
                contributionId: "workbench",
                action: "generate",
                kind: "generateTask",
              },
            ],
      async invoke(request) {
        if (tasks === undefined) throw new Error("plugin_tasks_unavailable");
        return tasks.createTask({
          invocationRef: request.invocationRef,
          threadId: "fixture-thread",
          expectedThreadRevision: 1,
          idempotencyKey: "fixture-optional-task",
          input: request.input,
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
