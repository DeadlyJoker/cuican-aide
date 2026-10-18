import {
  ControlApiClient,
  type ControlApiTeamTaskFence,
} from "./control-api-client.ts";

type TeamOperationNames =
  | "appendThreadMessage"
  | "authorizeOfficeRun"
  | "createRun"
  | "forkThread"
  | "getExecutionIntentCapability"
  | "getOffice"
  | "getRun"
  | "getThread"
  | "getThreadGoal"
  | "listThreadMessages"
  | "setThreadGoalWithExecutionIntentV1"
  | "startTurn";

/**
 * Control operations used by a durable Team host. The facade keeps its own
 * identity when a fence is attached so recovery tests and hosts can retain
 * operation-level instrumentation across the rebinding.
 */
export type ControlApiTeamOperations = Pick<
  ControlApiClient,
  TeamOperationNames
> & {
  withTeamTaskFence(fence: ControlApiTeamTaskFence): ControlApiTeamOperations;
};

export function createControlApiTeamOperations(
  client: ControlApiClient,
): ControlApiTeamOperations {
  let active = client;
  const result: ControlApiTeamOperations = {
    withTeamTaskFence: (fence: ControlApiTeamTaskFence) => {
      active = client.withTeamTaskFence(fence);
      return result;
    },
    appendThreadMessage: (
      ...args: Parameters<ControlApiClient["appendThreadMessage"]>
    ) => active.appendThreadMessage(...args),
    authorizeOfficeRun: (
      ...args: Parameters<ControlApiClient["authorizeOfficeRun"]>
    ) => active.authorizeOfficeRun(...args),
    createRun: (...args: Parameters<ControlApiClient["createRun"]>) =>
      active.createRun(...args),
    forkThread: (...args: Parameters<ControlApiClient["forkThread"]>) =>
      active.forkThread(...args),
    getExecutionIntentCapability: (
      ...args: Parameters<ControlApiClient["getExecutionIntentCapability"]>
    ) => active.getExecutionIntentCapability(...args),
    getOffice: (...args: Parameters<ControlApiClient["getOffice"]>) =>
      active.getOffice(...args),
    getRun: (...args: Parameters<ControlApiClient["getRun"]>) =>
      active.getRun(...args),
    getThread: (...args: Parameters<ControlApiClient["getThread"]>) =>
      active.getThread(...args),
    getThreadGoal: (...args: Parameters<ControlApiClient["getThreadGoal"]>) =>
      active.getThreadGoal(...args),
    listThreadMessages: (
      ...args: Parameters<ControlApiClient["listThreadMessages"]>
    ) => active.listThreadMessages(...args),
    setThreadGoalWithExecutionIntentV1: (
      ...args: Parameters<
        ControlApiClient["setThreadGoalWithExecutionIntentV1"]
      >
    ) => active.setThreadGoalWithExecutionIntentV1(...args),
    startTurn: (...args: Parameters<ControlApiClient["startTurn"]>) =>
      active.startTurn(...args),
  };
  return result;
}
