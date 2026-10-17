import type { FastifyInstance } from "fastify";
import {
  ApplicationError,
  type WorkflowVersionApplicationService,
} from "@crewon/application";
import {
  parseWorkflowVersionCatalogQuery,
  parseWorkflowVersionCatalogResponse,
  formatWorkflowVersionCursor,
} from "@crewon/contracts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
export function registerWorkflowCatalogRoutes(
  app: FastifyInstance,
  dependencies: {
    identity: ControlApiIdentityPort;
    workflowVersions: WorkflowVersionApplicationService;
  },
) {
  app.get<{ Querystring: Record<string, unknown> }>(
    "/api/v1/workflow-catalog",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const query = parseWorkflowVersionCatalogQuery({ ...request.query });
      const assets = await dependencies.workflowVersions.listCatalog(
        actor,
        query,
      );
      try {
        const data = assets;
        const last = data.at(-1);
        return parseWorkflowVersionCatalogResponse(
          {
            data,
            nextCursor:
              data.length === query.limit && last
                ? formatWorkflowVersionCursor(
                    last.workflowId,
                    last.workflowVersionId,
                  )
                : null,
          },
          query,
        );
      } catch (cause) {
        throw new ApplicationError(
          "internal",
          "workflow_catalog_projection_invalid",
          { cause },
        );
      }
    },
  );
}
