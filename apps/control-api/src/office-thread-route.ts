import type { FastifyInstance } from "fastify";
import type {
  OfficeThreadApplicationService,
  OfficeThreadMutation,
} from "@crewon/application";
import {
  parseBindOfficeThreadRequest,
  parseCreateOfficeThreadRequest,
  parseIdempotencyKey,
  parseOfficeVersionId,
  type OfficeThreadResponse,
  type OfficeThreadMutationResponse,
} from "@crewon/contracts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
import { projectThread } from "./thread-projection.ts";

export function registerOfficeThreadRoutes(
  app: FastifyInstance,
  dependencies: {
    officeThreads: OfficeThreadApplicationService;
    identity: ControlApiIdentityPort;
  },
): void {
  app.get<{ Params: { officeVersionId: string } }>(
    "/api/v1/offices/:officeVersionId/thread",
    async (request): Promise<OfficeThreadResponse> => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const result = await dependencies.officeThreads.get(
        actor,
        parseOfficeVersionId(request.params.officeVersionId),
      );
      return {
        officeId: result.office.officeId,
        officeVersionId: result.office.officeVersionId,
        thread: result.thread === null ? null : projectThread(result.thread),
      };
    },
  );
  app.post<{ Params: { officeVersionId: string }; Body: unknown }>(
    "/api/v1/offices/:officeVersionId/thread",
    async (request, reply) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      parseCreateOfficeThreadRequest(request.body);
      const result = await dependencies.officeThreads.create(actor, {
        officeVersionId: parseOfficeVersionId(request.params.officeVersionId),
        idempotencyKey: parseIdempotencyKey(request.headers["idempotency-key"]),
      });
      return reply
        .code(result.disposition === "created" ? 201 : 200)
        .send(project(result));
    },
  );
  app.post<{ Params: { officeVersionId: string }; Body: unknown }>(
    "/api/v1/offices/:officeVersionId/thread-binding",
    async (request): Promise<OfficeThreadMutationResponse> => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      return project(
        await dependencies.officeThreads.bind(actor, {
          ...parseBindOfficeThreadRequest(request.body),
          officeVersionId: parseOfficeVersionId(request.params.officeVersionId),
        }),
      );
    },
  );
}

function project(result: OfficeThreadMutation): OfficeThreadMutationResponse {
  return {
    officeId: result.office.officeId,
    officeVersionId: result.office.officeVersionId,
    disposition: result.disposition,
    thread: projectThread(result.thread),
  };
}
