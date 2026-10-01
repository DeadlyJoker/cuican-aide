import type { FastifyInstance } from "fastify";
import type { ExtensionReadApplicationService } from "@crewon/application";
import {
  parseExtensionEmptyQuery,
  parseExtensionPluginId,
  parseExtensionRuntimeQuery,
  parseExtensionRunId,
  parseExtensionCatalogResponse,
  parseExtensionRuntimeResponse,
  parseGetExtensionTaskResponse,
} from "@crewon/contracts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
import { projectExtensionTask } from "./extension-task-projection.ts";

/** Optional public projections share the authenticated Control identity and existing Run authorization. */
export function registerExtensionReadRoutes(
  app: FastifyInstance,
  dependencies: {
    identity: ControlApiIdentityPort;
    extensionReads: ExtensionReadApplicationService;
  },
): void {
  app.get<{ Querystring: unknown }>("/api/v1/extensions", async (request) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    parseExtensionEmptyQuery(request.query);
    return parseExtensionCatalogResponse(
      await dependencies.extensionReads.getCatalog(actor),
    );
  });
  app.get<{ Params: { pluginId: string }; Querystring: unknown }>(
    "/api/v1/extensions/:pluginId/runtime",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const input = {
        pluginId: parseExtensionPluginId(request.params.pluginId),
        ...parseExtensionRuntimeQuery(request.query),
      };
      return parseExtensionRuntimeResponse(
        await dependencies.extensionReads.getRuntime(actor, input),
        input,
      );
    },
  );
  app.get<{
    Params: { pluginId: string; runId: string };
    Querystring: unknown;
  }>("/api/v1/extensions/:pluginId/tasks/:runId", async (request) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    parseExtensionEmptyQuery(request.query);
    const input = {
      pluginId: parseExtensionPluginId(request.params.pluginId),
      runId: parseExtensionRunId(request.params.runId),
    };
    return parseGetExtensionTaskResponse(
      projectExtensionTask(
        await dependencies.extensionReads.getTask(actor, input),
      ),
      input,
    );
  });
}
