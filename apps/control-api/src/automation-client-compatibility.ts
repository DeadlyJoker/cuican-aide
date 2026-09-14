import { ApplicationError } from "@crewon/application";

export function supportsSkillSchedules(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): boolean {
  return headers["x-crewon-automation-version"] === "1";
}
export function requireSkillScheduleClient(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): void {
  if (!supportsSkillSchedules(headers))
    throw new ApplicationError(
      "conflict",
      "automation_client_upgrade_required",
    );
}
