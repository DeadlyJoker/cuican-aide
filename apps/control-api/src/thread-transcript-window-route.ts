import type { FastifyInstance } from "fastify";
import type { ThreadApplicationService } from "@crewon/application";
import {
  parseThreadMessageWindowQuery,
  parseThreadId,
  type GetThreadTranscriptWindowResponse,
} from "@crewon/contracts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
import { projectThreadMessageWindow } from "./thread-message-window-projection.ts";

export function registerThreadTranscriptWindowRoute(
  app: FastifyInstance,
  dependencies: {
    threads: ThreadApplicationService;
    identity: ControlApiIdentityPort;
  },
): void {
  app.get<{
    Params: { threadId: string };
    Querystring: Record<string, unknown>;
  }>("/api/v1/threads/:threadId/transcript-window", async (request) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    const threadId = parseThreadId(request.params.threadId);
    const query = parseThreadMessageWindowQuery({ ...request.query }, threadId);
    const window = await dependencies.threads.readTranscriptWindow(actor, {
      threadId,
      ...query,
    });
    const response: GetThreadTranscriptWindowResponse = {
      schemaVersion: "crewon.transcript-window.v0",
      messageWindow: projectThreadMessageWindow(window),
      runBindings: [...window.runBindings],
    };
    return response;
  });
}
