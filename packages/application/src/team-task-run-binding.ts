import {
  captureTeamTaskRunBinding as captureDomainTeamTaskRunBinding,
  type TeamTaskRunBinding,
} from "@crewon/domain";
import type { TeamTaskFence } from "./team-task-journal.ts";

export type { TeamTaskRunBinding } from "@crewon/domain";

/** Builds the immutable binding from trusted fence/capability inputs. */
export function createTeamTaskRunBinding(input: {
  fence: TeamTaskFence;
  capabilitySnapshotId: string;
}): TeamTaskRunBinding {
  return captureDomainTeamTaskRunBinding({
    schemaVersion: "crewon.team-task-run-binding.v0",
    tenantId: input.fence.tenantId,
    spaceId: input.fence.spaceId,
    teamTaskId: input.fence.taskId,
    parentTaskId: input.fence.taskId,
    admissionEpoch: input.fence.epoch,
    capabilitySnapshotId: input.capabilitySnapshotId,
  });
}

/** Captures the server-created Run binding before persistence or runtime use. */
export function captureTeamTaskRunBinding(input: unknown): TeamTaskRunBinding {
  return captureDomainTeamTaskRunBinding(input);
}
