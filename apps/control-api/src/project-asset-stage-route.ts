import {
  ApplicationError,
  type ThreadApplicationService,
} from "@crewon/application";
import {
  parseThreadId,
  parseIdempotencyKey,
  parseProjectTextEmptyQuery,
} from "@crewon/contracts";
import {
  MAX_PROJECT_ASSET_STAGES_BYTES,
  PROJECT_ASSET_STAGES_METHOD_ACTIONS,
  parseProjectAssetStagesActionRequest,
  parseProjectAssetStagesActionResponse,
  parseProjectAssetStageAvailabilityResponse,
} from "@crewon/contracts/project-asset-stages";
import type { FastifyInstance } from "fastify";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import {
  isProjectAssetStageControlOwner,
  type ProjectAssetStageControlOwner,
} from "./project-asset-stage-control-owner.ts";
import { requestContext } from "./request-context.ts";
import { wakeOutbox, type OutboxWakeupPort } from "./outbox-wakeup.ts";
export function registerProjectAssetStageRoutes(
  app: FastifyInstance,
  input: Readonly<{
    identity: ControlApiIdentityPort;
    owner: ProjectAssetStageControlOwner | null | undefined;
    outboxWakeup: OutboxWakeupPort;
    threads: Pick<ThreadApplicationService, "getThread">;
  }>,
): void {
  if (input.owner != null && !isProjectAssetStageControlOwner(input.owner))
    throw new Error("project_asset_stage_owner_required");
  app.get<{ Params: { threadId: string }; Querystring: unknown }>(
    "/api/v1/threads/:threadId/project-asset-stage",
    { exposeHeadRoute: false },
    async (request) => {
      const context = requestContext(request),
        actor = await input.identity.resolveActor(context),
        threadId = parseThreadId(request.params.threadId);
      parseProjectTextEmptyQuery(request.query);
      await input.threads.getThread(actor, threadId);
      return parseProjectAssetStageAvailabilityResponse(
        input.owner == null
          ? { available: false }
          : await input.owner.getAvailability(context, actor, threadId),
      );
    },
  );
  app.post<{
    Params: { threadId: string };
    Body: unknown;
    Querystring: unknown;
  }>(
    "/api/v1/threads/:threadId/project-asset-stage",
    { bodyLimit: MAX_PROJECT_ASSET_STAGES_BYTES },
    async (request, reply) => {
      const context = requestContext(request),
        actor = await input.identity.resolveActor(context);
      const threadId = parseThreadId(request.params.threadId);
      parseProjectTextEmptyQuery(request.query);
      const parsed = parseProjectAssetStagesActionRequest({
        action: PROJECT_ASSET_STAGES_METHOD_ACTIONS.startStage,
        input: request.body,
      });
      if (
        parsed.input.threadId !== threadId ||
        parsed.input.idempotencyKey !==
          parseIdempotencyKey(request.headers["idempotency-key"])
      )
        throw new ApplicationError(
          "validation",
          "project_asset_stage_request_invalid",
        );
      if (input.owner == null)
        throw new ApplicationError(
          "conflict",
          "project_asset_stage_unavailable",
        );
      const output = parseProjectAssetStagesActionResponse(
        parsed,
        await input.owner.startStage(context, actor, parsed.input),
      );
      wakeOutbox(input.outboxWakeup);
      return reply
        .code(output.disposition === "committed" ? 201 : 200)
        .send(output);
    },
  );
}
