import type { FastifyInstance } from "fastify";
import type { ThreadApplicationService } from "@crewon/application";
import {
  parseThreadMessageWindowQuery,
  parseThreadId,
  type GetThreadTranscriptSnapshotResponse,
} from "@crewon/contracts";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { requestContext } from "./request-context.ts";
import { projectThreadMessageWindow } from "./thread-message-window-projection.ts";

export function registerThreadTranscriptSnapshotRoute(
  app: FastifyInstance,
  dependencies: {
    threads: ThreadApplicationService;
    identity: ControlApiIdentityPort;
  },
): void {
  app.get<{
    Params: { threadId: string };
    Querystring: Record<string, unknown>;
  }>("/api/v1/threads/:threadId/transcript-snapshot", async (request) => {
    const actor = await dependencies.identity.resolveActor(
      requestContext(request),
    );
    const threadId = parseThreadId(request.params.threadId);
    const query = parseThreadMessageWindowQuery({ ...request.query }, threadId);
    const window = await dependencies.threads.readTranscriptSnapshot(actor, {
      threadId,
      ...query,
    });
    const response: GetThreadTranscriptSnapshotResponse = {
      schemaVersion: "crewon.transcript-snapshot.v0",
      transcriptWindow: {
        schemaVersion: "crewon.transcript-window.v0",
        messageWindow: projectThreadMessageWindow(window),
        runBindings: [...window.runBindings],
      },
      runs: [...window.runSnapshot!.runs],
      activeRunId: window.runSnapshot!.activeRunId,
    };
    return response;
  });
}
