import type { FastifyInstance } from "fastify";
import type { ExtensionTaskApplicationService } from "@crewon/application";
import {
  parseCreateExtensionTaskRequest,
  parseExtensionEmptyQuery,
  parseExtensionIdempotencyKey,
  parseExtensionPluginId,
  type ExtensionTaskMutationResponse,
} from "@crewon/contracts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { wakeOutbox, type OutboxWakeupPort } from "./outbox-wakeup.ts";
import { requestContext } from "./request-context.ts";

/** Task creation is opt-in and uses the existing authenticated Run/event boundary. */
export function registerExtensionTaskRoutes(
  app: FastifyInstance,
  dependencies: {
    identity: ControlApiIdentityPort;
    extensionTasks: ExtensionTaskApplicationService;
    outboxWakeup: OutboxWakeupPort;
  },
): void {
  app.post<{
    Params: { pluginId: string };
    Body: unknown;
    Querystring: unknown;
  }>(
    "/api/v1/extensions/:pluginId/tasks",
    async (request): Promise<ExtensionTaskMutationResponse> => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      parseExtensionEmptyQuery(request.query);
      const result = await dependencies.extensionTasks.createTask(actor, {
        ...parseCreateExtensionTaskRequest(request.body),
        pluginId: parseExtensionPluginId(request.params.pluginId),
        idempotencyKey: parseExtensionIdempotencyKey(
          request.headers["idempotency-key"],
        ),
      });
      const message = result.turn.messages[0];
      if (message === undefined || result.turn.messages.length !== 1)
        throw new Error("extension_turn_commit_invalid");
      wakeOutbox(dependencies.outboxWakeup);
      return {
        disposition: result.turn.disposition,
        threadId: result.binding.threadId,
        threadRevision: result.turn.threadState.revision,
        runId: result.binding.runId,
        messageId: message.messageId,
        configurationRevision: result.binding.configurationRevision,
      };
    },
  );
}
