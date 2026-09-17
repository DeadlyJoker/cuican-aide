import type { FastifyInstance } from "fastify";
import type { ThreadApplicationService } from "@crewon/application";
import {
  parseThreadMessageWindowQuery,
  parseThreadId,
} from "@crewon/contracts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
import { projectThreadMessageWindow } from "./thread-message-window-projection.ts";

export function registerThreadMessageWindowRoute(
  app: FastifyInstance,
  dependencies: {
    threads: ThreadApplicationService;
    identity: ControlApiIdentityPort;
  },
): void {
  app.get<{
    Params: { threadId: string };
    Querystring: Record<string, unknown>;
  }>("/api/v1/threads/:threadId/message-window", async (request) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    const threadId = parseThreadId(request.params.threadId);
    const query = parseThreadMessageWindowQuery({ ...request.query }, threadId);
    const window = await dependencies.threads.readMessageWindow(actor, {
      threadId,
      ...query,
    });
    return projectThreadMessageWindow(window);
  });
}
