import {
  ApplicationError,
  type ProjectConversationStore,
  type ThreadApplicationService,
} from "@crewon/application";
import {
  parseIdempotencyKey,
  parseThreadId,
  parseProjectTextEmptyQuery,
} from "@crewon/contracts";
import {
  MAX_PROJECT_CONVERSATIONS_BYTES,
  PROJECT_CONVERSATIONS_METHOD_ACTIONS as actions,
  parseProjectConversationsActionRequest,
  parseProjectConversationsActionResponse,
} from "@crewon/contracts/project-conversations";
import type { FastifyInstance } from "fastify";
import type {
  ControlApiIdentityPort,
  ControlApiRequestContext,
} from "./control-api-ports.ts";
import type { ProjectConversationControlOwner } from "./project-conversation-control-owner.ts";
import { requestContext } from "./request-context.ts";
import { wakeOutbox, type OutboxWakeupPort } from "./outbox-wakeup.ts";

export type ProjectConversationRouting = Pick<
  ProjectConversationStore,
  "hasThreadBinding"
>;
const ROOT = "/api/v1/threads/:threadId/project-conversation";

/** A Thread query uses original ownership. Binding presence is checked independently of feature approval. */
export function registerProjectConversationRoutes(
  app: FastifyInstance,
  input: Readonly<{
    identity: ControlApiIdentityPort;
    threads: Pick<ThreadApplicationService, "getThread">;
    owner: ProjectConversationControlOwner | null | undefined;
    routing: ProjectConversationRouting | null | undefined;
    outboxWakeup: OutboxWakeupPort;
  }>,
): void {
  app.get<{ Params: { threadId: string }; Querystring: unknown }>(
    ROOT,
    { exposeHeadRoute: false },
    async (request) => {
      const context = requestContext(request),
        actor = await input.identity.resolveActor(context);
      const threadId = parseThreadId(request.params.threadId);
      parseProjectTextEmptyQuery(request.query);
      await input.threads.getThread(actor, threadId);
      const parsed = parseProjectConversationsActionRequest({
        action: actions.getBinding,
        input: { threadId },
      });
      const value =
        input.owner == null
          ? await noOwnerBinding(input.routing, actor, threadId)
          : await input.owner.getBinding(context, actor, threadId);
      return parseProjectConversationsActionResponse(parsed, value);
    },
  );
  app.post<{
    Params: { threadId: string };
    Body: unknown;
    Querystring: unknown;
  }>(
    `${ROOT}/stages`,
    { bodyLimit: MAX_PROJECT_CONVERSATIONS_BYTES },
    async (request, reply) => {
      const context = requestContext(request),
        actor = await input.identity.resolveActor(context);
      const threadId = parseThreadId(request.params.threadId);
      parseProjectTextEmptyQuery(request.query);
      const parsed = parseProjectConversationsActionRequest({
        action: actions.startStage,
        input: request.body,
      });
      if (
        parsed.action !== actions.startStage ||
        parsed.input.threadId !== threadId ||
        parsed.input.idempotencyKey !==
          parseIdempotencyKey(request.headers["idempotency-key"])
      )
        throw new ApplicationError(
          "validation",
          "project_conversation_request_invalid",
        );
      if (input.owner == null) unavailable();
      const output = parseProjectConversationsActionResponse(
        parsed,
        await input.owner.startStage(context, actor, parsed.input),
      );
      wakeOutbox(input.outboxWakeup);
      return reply
        .code(
          "disposition" in output && output.disposition === "committed"
            ? 201
            : 200,
        )
        .send(output);
    },
  );
}

async function noOwnerBinding(
  routing: ProjectConversationRouting | null | undefined,
  actor: Readonly<{ tenantId: string; spaceId: string }>,
  threadId: string,
) {
  if (
    routing != null &&
    (await routing.hasThreadBinding({
      tenantId: actor.tenantId,
      spaceId: actor.spaceId,
      threadId,
    }))
  )
    unavailable();
  return { binding: null };
}
export function projectConversationUnavailable(): never {
  return unavailable();
}
function unavailable(): never {
  throw new ApplicationError("conflict", "project_conversation_unavailable");
}
