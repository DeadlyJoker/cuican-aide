import type { FastifyInstance } from "fastify";
import {
  parseIdempotencyKey,
  parseTeamTaskAdmissionRequest,
  parseTeamTaskAdmissionResponse,
} from "@crewon/contracts";
import type { ActorContext } from "@crewon/application";
import type {
  TeamTaskAdmissionApplicationService,
  AdmitTeamTaskCommand,
} from "@crewon/application/team-task-admission";
import type { ControlApiIdentityPort } from "./control-api-ports.ts";
import { WorkspaceControlUnavailableError } from "./control-api-errors.ts";
import { requestContext } from "./request-context.ts";

export function registerTeamTaskAdmissionRoute(
  app: FastifyInstance,
  dependencies: {
    identity: ControlApiIdentityPort;
    service?: Pick<TeamTaskAdmissionApplicationService, "admit"> | null;
    wake?: () => void;
  },
): void {
  app.post<{ Body: unknown }>(
    "/api/v1/team-tasks:admit-v1",
    async (request, reply) => {
      if (dependencies.service == null)
        throw new WorkspaceControlUnavailableError();
      const actor: ActorContext = await dependencies.identity.resolveActor(
        requestContext(request),
      );
      const body = parseTeamTaskAdmissionRequest(request.body);
      const taskId = parseIdempotencyKey(request.headers["idempotency-key"]);
      const result = await dependencies.service.admit(actor, {
        kind: "teamTask.admit",
        taskId,
        ...body,
      } satisfies AdmitTeamTaskCommand);
      dependencies.wake?.();
      const task = result.task;
      const mainMessageSequence = task.intent.mainMessageSequence;
      if (
        typeof mainMessageSequence !== "number" ||
        !Number.isSafeInteger(mainMessageSequence) ||
        mainMessageSequence < 1
      )
        throw new Error("team_task_admission_response_invalid");
      const sequence = mainMessageSequence as number;
      return reply.code(result.disposition === "committed" ? 201 : 200).send(
        parseTeamTaskAdmissionResponse({
          schemaVersion: "crewon.team-task-admission.v1",
          disposition: result.disposition,
          task: {
            taskId: task.intent.taskId,
            threadId: task.intent.turn.threadId,
            status: task.status,
            revision: task.revision,
            cancelRequested: task.cancelRequested,
            mainMessageSequence: sequence,
          },
        }),
      );
    },
  );
}
