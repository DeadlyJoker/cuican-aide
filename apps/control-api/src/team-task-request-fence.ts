import type { FastifyRequest } from "fastify";
import { ApplicationError, type ActorContext } from "@crewon/application";
import type { TeamTaskWriteFence } from "@crewon/application/team-task-journal";

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value)
    ? value.length === 1
      ? value[0]
      : undefined
    : value;
}

/** Header is only an untrusted locator; Store transaction verifies its lease. */
export function readTeamTaskWriteFence(
  request: FastifyRequest,
  actor: ActorContext,
): TeamTaskWriteFence | undefined {
  const taskId = one(request.headers["x-crewon-team-task-id"]);
  const ownerId = one(request.headers["x-crewon-team-task-owner"]);
  const leaseId = one(request.headers["x-crewon-team-task-lease"]);
  const epochText = one(request.headers["x-crewon-team-task-epoch"]);
  const values = [taskId, ownerId, leaseId, epochText];
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined))
    throw new ApplicationError(
      "validation",
      "team_task_reservation_header_invalid",
    );
  const epoch = Number(epochText);
  if (!Number.isSafeInteger(epoch) || epoch < 1)
    throw new ApplicationError(
      "validation",
      "team_task_reservation_header_invalid",
    );
  return {
    tenantId: actor.tenantId,
    spaceId: actor.spaceId,
    taskId: taskId!,
    ownerId: ownerId!,
    leaseId: leaseId!,
    epoch,
  };
}
