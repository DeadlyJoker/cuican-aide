export type ControlTeamExecutionMode = "legacy" | "durableTask";

/**
 * The durable Team path is an explicit development experiment until its visible
 * UI flow has passed end-to-end acceptance. Unknown values fail closed.
 */
export function readControlTeamExecutionMode(
  value: string | undefined = import.meta.env
    .VITE_CREWON_EXPERIMENTAL_DURABLE_TEAM_TASKS,
): ControlTeamExecutionMode {
  if (value === undefined || value === "") return "legacy";
  if (value === "0") return "legacy";
  if (value === "1") return "durableTask";
  throw new Error("crewon_experimental_durable_team_tasks_invalid");
}
