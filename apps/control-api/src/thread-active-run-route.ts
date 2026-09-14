import type { FastifyInstance } from "fastify";
import type { RunApplicationService } from "@crewon/application";
import {
  parseThreadId,
  type GetThreadActiveRunResponse,
} from "@crewon/contracts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
import { projectRun } from "./run-projection.ts";

export function registerThreadActiveRunRoute(
  app: FastifyInstance,
  dependencies: {
    application: RunApplicationService;
    identity: ControlApiIdentityPort;
  },
): void {
  app.get<{ Params: { threadId: string } }>(
    "/api/v1/threads/:threadId/active-run",
    async (request) => {
      const actor = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const threadId = parseThreadId(request.params.threadId);
      const run = await dependencies.application.getActiveRunInThread(
        actor,
        threadId,
      );
      const response: GetThreadActiveRunResponse = {
        schemaVersion: "crewon.thread-active-run.v0",
        threadId,
        run: run === null ? null : projectRun(run),
      };
      return response;
    },
  );
}
