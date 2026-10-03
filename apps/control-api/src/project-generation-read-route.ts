import type { FastifyInstance } from "fastify";
import type {
  ExtensionReadApplicationService,
  ProjectGenerationReadApplicationService,
} from "@crewon/application";
import {
  parseConceptGenerationLocator,
  parseCreativeProjectEmptyQuery,
  parseCreativeProjectRevision,
} from "@crewon/contracts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { withInstalledPluginHttpRequest } from "./installed-plugin-request-owner.ts";
import { projectConceptGeneration } from "./project-generation-read-projection.ts";
import { requestContext } from "./request-context.ts";

/** Explicit opt-in read capability; no task admission, supplier polling, or credit mutation. */
export function registerProjectGenerationReadRoutes(
  app: FastifyInstance,
  dependencies: Readonly<{
    identity: ControlApiIdentityPort;
    projectGenerationReads: ProjectGenerationReadApplicationService;
    extensionReads: ExtensionReadApplicationService;
  }>,
): void {
  const generations = dependencies.projectGenerationReads;
  const reads = dependencies.extensionReads;
  app.get<{
    Params: { projectId: string; assetId: string; assetRevision: string };
    Querystring: unknown;
  }>(
    "/api/v1/creative-projects/:projectId/concepts/:assetId/revisions/:assetRevision/generation",
    { exposeHeadRoute: false },
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      parseCreativeProjectEmptyQuery(request.query);
      const locator = parseConceptGenerationLocator({
        projectId: request.params.projectId,
        assetId: request.params.assetId,
        assetRevision: parseCreativeProjectRevision(
          request.params.assetRevision,
        ),
      });
      return projectConceptGeneration(
        await withInstalledPluginHttpRequest(reads, request, reply, actor, () =>
          generations.getConceptGeneration(actor, locator),
        ),
      );
    },
  );
}
