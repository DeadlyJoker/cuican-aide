import type { FastifyInstance } from "fastify";
import {
  parseIdempotencyKey,
  parseTeamTaskCancelRequest,
  parseTeamTaskSnapshotResponse,
} from "@crewon/contracts";
import type { ActorContext } from "@crewon/application";
import type { TeamTaskAdmissionApplicationService } from "@crewon/application/team-task-admission";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { WorkspaceControlUnavailableError } from "./control-api-errors.ts";
import { requestContext } from "./request-context.ts";

type TeamTaskControlService = Pick<
  TeamTaskAdmissionApplicationService,
  "read" | "cancel"
>;

function project(task: Awaited<ReturnType<TeamTaskControlService["read"]>>) {
  return parseTeamTaskSnapshotResponse({
    schemaVersion: "crewon.team-task-snapshot.v1",
    task: {
      taskId: task.intent.taskId,
      threadId: task.intent.turn.threadId,
      status: task.status,
      revision: task.revision,
      cancelRequested: task.cancelRequested,
      mainMessageSequence: task.intent.mainMessageSequence ?? null,
      resultRunId: task.result?.run.runId ?? null,
    },
  });
}

export function registerTeamTaskControlRoutes(
  app: FastifyInstance,
  dependencies: {
    identity: ControlApiIdentityPort;
    service?: TeamTaskControlService | null;
    wake?: () => void;
  },
): void {
  app.get<{ Params: { taskId: string } }>(
    "/api/v1/team-tasks/:taskId",
    async (request, reply) => {
      if (dependencies.service == null)
        throw new WorkspaceControlUnavailableError();
      const actor: ActorContext = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      return reply
        .header("cache-control", "no-store")
        .send(
          project(
            await dependencies.service.read(actor, request.params.taskId),
          ),
        );
    },
  );
  app.post<{ Params: { taskId: string }; Body: unknown }>(
    "/api/v1/team-tasks/:taskId([^:]+)::cancel",
    async (request, reply) => {
      if (dependencies.service == null)
        throw new WorkspaceControlUnavailableError();
      const actor: ActorContext = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      parseTeamTaskCancelRequest(request.body);
      parseIdempotencyKey(request.headers["idempotency-key"]);
      const result = await dependencies.service.cancel(
        actor,
        request.params.taskId,
      );
      dependencies.wake?.();
      return reply.header("cache-control", "no-store").send(project(result));
    },
  );
}
