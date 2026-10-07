import type { FastifyInstance } from "fastify";
import {
  isProjectMediaResultCatalogApplicationService,
  ProjectMediaResultCatalogApplicationService,
} from "@crewon/application";
import { ContractValidationError } from "@crewon/contracts";
import { parseListProjectMediaResultsRequest } from "@crewon/contracts/project-media-results";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
import { withProjectMediaRequestSignal } from "./project-media-request-signal.ts";

/** Explicitly composed read service; identity and independent catalog purpose checks apply to every page. */
export function registerProjectMediaResultCatalogRoutes(
  app: FastifyInstance,
  input: Readonly<{
    identity: ControlApiIdentityPort;
    service: ProjectMediaResultCatalogApplicationService;
  }>,
): void {
  if (!isProjectMediaResultCatalogApplicationService(input.service))
    throw new Error("project_media_result_catalog_service_required");
  const list =
    ProjectMediaResultCatalogApplicationService.prototype.listCandidates.bind(
      input.service,
    );
  app.get<{ Params: { projectId: string }; Querystring: unknown }>(
    "/api/v1/creative-projects/:projectId/media-results",
    { exposeHeadRoute: false },
    async (request, reply) =>
      withProjectMediaRequestSignal(request, reply, async (signal) => {
        const actor = await input.identity.resolveActor(
          requestContext(request),
        );
        const q = queryFields(request.query);
        if (q.limit !== undefined && !/^(?:[1-9]|1[0-6])$/u.test(q.limit))
          invalid();
        const command = parseListProjectMediaResultsRequest({
          projectId: request.params.projectId,
          afterCandidateId: q.afterCandidateId ?? null,
          limit: q.limit === undefined ? 16 : Number(q.limit),
        });
        const result = await list(actor, command, { signal });
        signal.throwIfAborted();
        reply.header("cache-control", "no-store");
        return result;
      }),
  );
}
function queryFields(input: unknown): Record<string, string> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    invalid();
  const keys = Reflect.ownKeys(input),
    copy: Record<string, string> = {};
  if (keys.length > 2) invalid();
  for (const key of keys) {
    if (typeof key !== "string" || !["limit", "afterCandidateId"].includes(key))
      invalid();
    const d = Object.getOwnPropertyDescriptor(input, key);
    if (
      !d?.enumerable ||
      !Object.hasOwn(d, "value") ||
      typeof d.value !== "string" ||
      d.value.length > 128
    )
      invalid();
    copy[key] = d.value;
  }
  return copy;
}
function invalid(): never {
  throw new ContractValidationError("project_media_results_contract_invalid");
}
