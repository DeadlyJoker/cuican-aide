import type { CrewonWorkflowExecution } from "./crewonWorkflow";

/** A fresh submission must never borrow the previous run's output or controls. */
export function currentWorkflowExecution({
  persisted,
  local,
  excludedExecutionId,
}: {
  persisted: CrewonWorkflowExecution | null;
  local: CrewonWorkflowExecution | null;
  excludedExecutionId: string | null;
}): CrewonWorkflowExecution | null {
  const currentPersisted =
    persisted?.executionId === excludedExecutionId ? null : persisted;
  const currentLocal =
    local?.executionId === excludedExecutionId ? null : local;
  return currentLocal?.status === "canceled"
    ? currentLocal
    : (currentPersisted ?? currentLocal);
}
