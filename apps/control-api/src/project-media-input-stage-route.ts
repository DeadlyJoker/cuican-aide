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
  MAX_PROJECT_MEDIA_INPUT_STAGES_BYTES,
  PROJECT_MEDIA_INPUT_STAGES_METHOD_ACTIONS,
  parseProjectMediaInputStagesActionRequest,
  parseProjectMediaInputStagesActionResponse,
  parseProjectMediaInputStageAvailabilityResponse,
} from "@crewon/contracts/project-media-input-stages";
import type { FastifyInstance } from "fastify";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import {
  isProjectMediaInputStageControlOwner,
  type ProjectMediaInputStageControlOwner,
} from "./project-media-input-stage-control-owner.ts";
import { requestContext } from "./request-context.ts";
import { wakeOutbox, type OutboxWakeupPort } from "./outbox-wakeup.ts";
export function registerProjectMediaInputStageRoutes(
  app: FastifyInstance,
  input: Readonly<{
    identity: ControlApiIdentityPort;
    owner: ProjectMediaInputStageControlOwner | null | undefined;
    outboxWakeup: OutboxWakeupPort;
    threads: Pick<ThreadApplicationService, "getThread">;
  }>,
): void {
  if (input.owner != null && !isProjectMediaInputStageControlOwner(input.owner))
    throw new Error("project_media_input_stage_owner_required");
  app.get<{ Params: { threadId: string }; Querystring: unknown }>(
    "/api/v1/threads/:threadId/project-media-input-stage",
    { exposeHeadRoute: false },
    async (request) => {
      const context = requestContext(request),
        actor = await input.identity.resolveActor(context),
        threadId = parseThreadId(request.params.threadId);
      parseProjectTextEmptyQuery(request.query);
      await input.threads.getThread(actor, threadId);
      return parseProjectMediaInputStageAvailabilityResponse(
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
    "/api/v1/threads/:threadId/project-media-input-stage",
    { bodyLimit: MAX_PROJECT_MEDIA_INPUT_STAGES_BYTES },
    async (request, reply) => {
      const context = requestContext(request),
        actor = await input.identity.resolveActor(context);
      const threadId = parseThreadId(request.params.threadId);
      parseProjectTextEmptyQuery(request.query);
      const parsed = parseProjectMediaInputStagesActionRequest({
        action: PROJECT_MEDIA_INPUT_STAGES_METHOD_ACTIONS.startStage,
        input: request.body,
      });
      if (
        parsed.input.threadId !== threadId ||
        parsed.input.idempotencyKey !==
          parseIdempotencyKey(request.headers["idempotency-key"])
      )
        throw new ApplicationError(
          "validation",
          "project_media_input_stage_request_invalid",
        );
      if (input.owner == null)
        throw new ApplicationError(
          "conflict",
          "project_media_input_stage_unavailable",
        );
      const output = parseProjectMediaInputStagesActionResponse(
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
