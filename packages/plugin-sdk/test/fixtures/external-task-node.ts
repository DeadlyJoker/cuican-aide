import {
  definePlugin,
  CREWON_TASKS_SERVICE,
  CREWON_TASKS_API_VERSION,
  type PluginTaskService,
  type PluginActionsService,
} from "@crewon/plugin-sdk/node";

export default definePlugin({
  apiVersion: "crewon.plugin-host.v1",
  pluginId: "example.tasks",
  setup(context) {
    const tasks = context.services.get<PluginTaskService>(
      CREWON_TASKS_SERVICE,
      CREWON_TASKS_API_VERSION,
    );
    const actions: PluginActionsService = {
      actions: [
        {
          contributionId: "workbench",
          action: "image.generate",
          kind: "generateTask",
        },
      ],
      async invoke(request) {
        return tasks.createTask({
          invocationRef: request.invocationRef,
          threadId: "fixture-thread",
          expectedThreadRevision: 1,
          idempotencyKey: "fixture-task-key",
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
