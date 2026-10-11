import { ApplicationError, type ActorContext } from "@crewon/application";
import {
  parsePluginCompositionStatusResponse,
  parsePluginSelectionListQuery,
  type PluginCompositionStatusResponse,
  type PluginSelectionListQuery,
} from "@crewon/contracts";
import type { FastifyInstance } from "fastify";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";

/** The actual profile owner performs scope/current-authority checks and observes its live instances. */
export type PluginCompositionStatusControlService = Readonly<{
  listStatus(
    actor: ActorContext,
    query: PluginSelectionListQuery,
  ): Promise<PluginCompositionStatusResponse>;
}>;

export function registerPluginCompositionStatusRoute(
  app: FastifyInstance,
  dependencies: Readonly<{
    identity: ControlApiIdentityPort;
    service: PluginCompositionStatusControlService;
  }>,
): void {
  app.get<{ Querystring: unknown }>(
    "/api/v1/plugins/composition/status",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
      reply.header("cross-origin-resource-policy", "same-origin");
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const query = parsePluginSelectionListQuery(request.query);
      const result = await dependencies.service.listStatus(actor, query);
      try {
        return parsePluginCompositionStatusResponse(result, query);
      } catch (cause) {
        throw new ApplicationError(
          "internal",
          "plugin_composition_status_response_invalid",
          { cause },
        );
      }
    },
  );
}
