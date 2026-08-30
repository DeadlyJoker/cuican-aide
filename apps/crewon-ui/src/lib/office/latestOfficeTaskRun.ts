import type { OfficeRunActivity } from "../domain/crewonDomain";

export function latestOfficeTaskRun(
  runs: OfficeRunActivity[] | undefined,
): OfficeRunActivity | null {
  const taskRuns = runs?.filter(
    (run) => run.messageIntent !== "conversation",
  );
  if (!taskRuns?.length) {
    return null;
  }
  return [...taskRuns].sort((left, right) =>
    officeRunTimestamp(right).localeCompare(officeRunTimestamp(left)),
  )[0];
}

function officeRunTimestamp(run: OfficeRunActivity) {
  return run.updatedAt ?? run.completedAt ?? run.createdAt ?? "";
}
