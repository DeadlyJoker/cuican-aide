import {
  ApplicationError,
  PluginProjectTextPlanActionOwner,
  ProjectTextPlanCoordinator,
  type ApplicationClock,
  type ContentDigester,
  type ProjectTextApplicationService,
  type ActorContext,
  type InvokePluginUiActionCommand,
  type PluginUiJsonValue,
} from "@crewon/application";
import { parseProjectTextPlansActionRequest } from "@crewon/contracts/project-text-plans";
import type { PluginProfileScope, RunLifecycleEvent } from "@crewon/domain";
import type { SqliteRunStore, PostgresDomainStore } from "@crewon/store";
import type { ControlApiRequestContext } from "./control-api-ports.ts";
import type { PreparedProjectTextPlans } from "./project-text-plan-composition.ts";
import type { ProjectConversationControlOwner } from "./project-conversation-control-owner.ts";
import type { InstalledPluginTaskRuntimeCore } from "./installed-plugin-task-runtime-core.ts";
import type { InstalledPluginRequestOwner } from "./installed-plugin-request-owner.ts";
import { ProjectTextPlanControlOwner } from "./project-text-plan-control-owner.ts";
import { ProjectTextPlanDurableCoordinator } from "./project-text-plan-durable-coordinator.ts";

export type ProjectTextPlanPluginUiRuntime = Readonly<{
  owner: PluginProjectTextPlanActionOwner;
  start(): void;
  consumeRunEvents(events: readonly RunLifecycleEvent[]): Promise<void>;
  invokeAuthenticatedRequest(
    request: ControlApiRequestContext,
    actor: ActorContext,
    command: InvokePluginUiActionCommand,
    signal: AbortSignal | undefined,
    invoke: () => Promise<PluginUiJsonValue>,
  ): Promise<PluginUiJsonValue>;
  close(): Promise<void>;
}>;

/** Borrow the same live conversation owner, parent Store and original Task core. */
export function createProjectTextPlanPluginUiRuntime(
  input: Readonly<{
    foundation: PreparedProjectTextPlans;
    conversations: ProjectConversationControlOwner;
    requests: InstalledPluginRequestOwner;
    store: SqliteRunStore | PostgresDomainStore;
    tasks: () => InstalledPluginTaskRuntimeCore | undefined;
    textCommands: ProjectTextApplicationService;
    /** Only a deployment-issued fixed profile can own a durable scanner. */
    scope?: PluginProfileScope;
    clock: ApplicationClock;
    digester: ContentDigester;
  }>,
): ProjectTextPlanPluginUiRuntime {
  const foundation = input.foundation;
  const control = new ProjectTextPlanControlOwner({
    configuration: foundation.configuration,
    plans: foundation.store,
    conversations: foundation.conversations.store,
    conversationOwner: input.conversations,
    requests: input.requests,
    authorization: foundation.authorization,
    digester: input.digester,
    modelSelection: () => input.tasks()?.modelSelection,
  });
  const owner = new PluginProjectTextPlanActionOwner({
    plans: foundation.service,
    publications: foundation.configuration.publications,
    authorization: control.authorization,
  });
  const coordinator = new ProjectTextPlanCoordinator({
    plans: foundation.store,
    continuation: control.continuation,
    projects: foundation.projects,
    texts: foundation.texts,
    conversations: foundation.conversations.store,
    threads: input.store,
    runs: input.store,
    tasks: {
      createProjectTextPlanTurnFromHost: (...args) => {
        const tasks = input.tasks();
        if (tasks === undefined)
          throw new ApplicationError(
            "conflict",
            "project_text_plan_execution_unavailable",
          );
        return tasks.extensionTasks.createProjectTextPlanTurnFromHost(...args);
      },
    },
    textCommands: input.textCommands,
    clock: input.clock,
    digester: input.digester,
  });
  // Remote profiles without a current delegated identity remain durable paused plans.
  const durable =
    input.scope === undefined || !input.requests.supportsDelegatedIdentity()
      ? undefined
      : new ProjectTextPlanDurableCoordinator({
          store: foundation.store,
          coordinator,
          scope: input.scope,
          digester: input.digester,
        });
  let closed = false;
  let closing: Promise<void> | undefined;
  return Object.freeze({
    owner,
    start: () => {
      if (!closed) durable?.start();
    },
    consumeRunEvents: (events) =>
      closed
        ? Promise.resolve()
        : (durable?.consumeRunEvents(events) ?? Promise.resolve()),
    invokeAuthenticatedRequest: (request, actor, command, signal, invoke) => {
      if (closed)
        throw new ApplicationError("conflict", "project_text_plan_unavailable");
      parseProjectTextPlansActionRequest({
        action: command.action,
        input: command.input,
      });
      return input.requests.run(
        { request, actor, signal, preparation: "configuration" },
        invoke,
      );
    },
    close: () => {
      closed = true;
      return (closing ??= (async () => {
        await durable?.close();
        await owner.close();
      })());
    },
  });
}
